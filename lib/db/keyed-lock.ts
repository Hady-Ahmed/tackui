/**
 * Per-key in-process FIFO semaphore for HOT-ROW writers.
 *
 * The credentials PUT (#124) and updateTemplate (#127) do their
 * read-merge-write inside `withTransaction` holding the row's
 * `SELECT ... FOR UPDATE` lock. Every writer BLOCKED on that row lock
 * holds a checked-out pool connection for the duration of the wait —
 * more concurrent writers to one row than `PG_POOL_MAX` (default 10)
 * and the excess writers time out waiting for a connection instead of
 * queueing on the row lock.
 *
 * `withKeyedLock` bounds the waiters per row: the caller acquires the
 * key's lock BEFORE the transaction opens, so at most one writer per
 * row is inside `withTransaction` at any instant. Blocked writers wait
 * in-process (a promise per waiter — no pool contact), and pg
 * connection acquisition then only happens for the admitted writer, so
 * a pile-up on one row can no longer exhaust the pool. Writers to
 * DIFFERENT rows use different keys and never block each other (a
 * global mutex over all template updates would just move the
 * bottleneck into the app).
 *
 * Waiting is BOUNDED, not unbounded (#153): a wedged lock holder would
 * otherwise park same-key waiters forever. Both mechanisms are
 * configurable per call via `options` and armed by default:
 * - Wait timeout (default `DEFAULT_LOCK_WAIT_TIMEOUT_MS` = 30s): a
 *   waiter parked longer than this rejects with
 *   `KeyedLockUnavailableError` (`reason: "wait-timeout"`). Holders are
 *   bounded in practice by `withTransaction`'s error paths; the timeout
 *   is the backstop so a hung holder can't accumulate waiters
 *   indefinitely. `Infinity` opts a caller out of the timeout.
 * - Queue cap (default `DEFAULT_MAX_LOCK_WAITERS` = 32): once 32
 *   same-key waiters are queued, further arrivals fail fast with the
 *   same typed error (`reason: "queue-full"`) — a pile-up that deep is
 *   pathological regardless of holder health. The cap bounds the wait
 *   QUEUE only; an uncontended acquire never queues.
 * A waiter that gives up is removed from the queue, so it can never
 * receive a later handoff (that would strand the lock on a caller that
 * already saw the rejection). Callers surface the typed error as
 * retryable — the two routes holding the lock map it to a 503
 * "please try again", never the generic 500.
 *
 * Semantics:
 * - FIFO handoff, no barging: a released lock is handed directly to the
 *   oldest waiter; a newcomer arriving between the handoff and the
 *   waiter's resumption still queues behind it (the map entry stays
 *   until the admitted waiter's own release).
 * - The key's map entry is deleted when the last holder releases, so
 *   the map never grows with retired keys.
 * - In-process only: it serializes writers within one Node process.
 *   Multi-process deployments still rely on the row's `FOR UPDATE`
 *   lock for correctness — the semaphore is pool protection, not the
 *   serialization point.
 */

export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_LOCK_WAITERS = 32;

export type KeyedLockFailureReason = "wait-timeout" | "queue-full";

/**
 * Thrown when a waiter gives up on acquiring a key's lock — by wait
 * timeout (`reason: "wait-timeout"`) or because the same-key wait queue
 * is at its cap (`reason: "queue-full"`). `code` is the stable
 * machine-readable identity; `reason` discriminates the two modes.
 * Retryable by nature: the holder may still be mid-write, so a caller
 * that cares retries later instead of treating it as a server fault.
 */
export class KeyedLockUnavailableError extends Error {
  readonly code = "KEYED_LOCK_UNAVAILABLE";

  constructor(
    readonly reason: KeyedLockFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "KeyedLockUnavailableError";
  }
}

export interface KeyedLockOptions {
  /**
   * Max milliseconds a waiter may sit queued before rejecting with
   * `KeyedLockUnavailableError` ("wait-timeout"). `Infinity` waits
   * forever (the pre-bounds behavior).
   */
  waitTimeoutMs?: number;
  /**
   * Max same-key waiters allowed to queue; arrivals beyond this fail
   * fast with `KeyedLockUnavailableError` ("queue-full"). `Infinity`
   * disables the cap.
   */
  maxWaiters?: number;
}

interface ResolvedLockOptions {
  waitTimeoutMs: number;
  maxWaiters: number;
}

function resolveOptions(options?: KeyedLockOptions): ResolvedLockOptions {
  const waitTimeoutMs = options?.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const maxWaiters = options?.maxWaiters ?? DEFAULT_MAX_LOCK_WAITERS;
  // A misparsed config value (NaN from a broken env parse, 0 from a
  // bad default) must fail loudly at the call, not silently turn every
  // contended acquire into an instant failure.
  if (!(waitTimeoutMs > 0)) {
    throw new RangeError(
      `withKeyedLock: waitTimeoutMs must be a positive number or Infinity, got ${String(waitTimeoutMs)}`,
    );
  }
  if (maxWaiters !== Infinity && (!Number.isInteger(maxWaiters) || maxWaiters < 1)) {
    throw new RangeError(
      `withKeyedLock: maxWaiters must be a positive integer or Infinity, got ${String(maxWaiters)}`,
    );
  }
  return { waitTimeoutMs, maxWaiters };
}

interface Waiter {
  admit: () => void;
  abandon: () => void;
}

interface LockEntry {
  waiters: Waiter[];
}

const locks = new Map<string, LockEntry>();

async function acquire(key: string, opts: ResolvedLockOptions): Promise<void> {
  const entry = locks.get(key);
  if (!entry) {
    // Free — become the holder. Map presence IS the held flag.
    locks.set(key, { waiters: [] });
    return;
  }
  if (entry.waiters.length >= opts.maxWaiters) {
    throw new KeyedLockUnavailableError(
      "queue-full",
      `keyed-lock: wait queue for key "${key}" is full (${entry.waiters.length} waiters, cap ${opts.maxWaiters})`,
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const waiter: Waiter = {
      admit: () => settle(resolve),
      abandon: () => {
        // Leave the queue so a later release shifts the next LIVING
        // waiter — a handoff to an already-rejected waiter would strand
        // the lock on a caller that stopped waiting (the wedged-lock
        // hazard this timeout exists to bound).
        const idx = entry.waiters.indexOf(waiter);
        if (idx !== -1) entry.waiters.splice(idx, 1);
        settle(() =>
          reject(
            new KeyedLockUnavailableError(
              "wait-timeout",
              `keyed-lock: timed out after ${opts.waitTimeoutMs}ms waiting for key "${key}"`,
            ),
          ),
        );
      },
    };
    entry.waiters.push(waiter);
    if (opts.waitTimeoutMs !== Infinity) {
      timer = setTimeout(() => {
        // settle() clears the timer on admission, so this can only fire
        // while still queued; the !settled guard is defense-in-depth so
        // a late fire can never act on a waiter that holds the lock.
        if (!settled) waiter.abandon();
      }, opts.waitTimeoutMs);
    }
  });
}

function release(key: string): void {
  const entry = locks.get(key);
  if (!entry) {
    // Never expected — release is `finally`-guarded one-per-acquire, so a
    // missing entry means a double-release (or release of a never-held key).
    // Surfacing it loudly beats silently masking a future bookkeeping bug.
    console.error(`[keyed-lock] release of unheld key "${key}"`);
    return;
  }
  const next = entry.waiters.shift();
  if (next) {
    next.admit(); // hand the lock to the oldest waiter — the entry stays
  } else {
    locks.delete(key);
  }
}

/**
 * Run `fn` while holding the key's lock. Same-key calls serialize in
 * FIFO order; different keys are fully independent. Waiting is bounded
 * (see the module docstring): contended calls can reject with
 * `KeyedLockUnavailableError` per the `options` bounds — happy paths
 * are unchanged. `fn`'s rejection propagates to its own caller and
 * releases the lock (the next waiter proceeds).
 */
export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
  options?: KeyedLockOptions,
): Promise<T> {
  await acquire(key, resolveOptions(options));
  try {
    return await fn();
  } finally {
    release(key);
  }
}
