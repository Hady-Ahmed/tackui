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

interface LockEntry {
  waiters: Array<() => void>;
}

const locks = new Map<string, LockEntry>();

async function acquire(key: string): Promise<void> {
  const entry = locks.get(key);
  if (!entry) {
    // Free — become the holder. Map presence IS the held flag.
    locks.set(key, { waiters: [] });
    return;
  }
  await new Promise<void>((resolve) => entry.waiters.push(resolve));
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
    next(); // hand the lock to the oldest waiter — the entry stays
  } else {
    locks.delete(key);
  }
}

/**
 * Run `fn` while holding the key's lock. Same-key calls serialize in
 * FIFO order; different keys are fully independent. `fn`'s rejection
 * propagates to its own caller and releases the lock (the next waiter
 * proceeds).
 */
export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquire(key);
  try {
    return await fn();
  } finally {
    release(key);
  }
}
