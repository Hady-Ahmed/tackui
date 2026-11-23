import { describe, it, expect } from "vitest";
import {
  withKeyedLock,
  KeyedLockUnavailableError,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  DEFAULT_MAX_LOCK_WAITERS,
} from "./keyed-lock";

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let queued acquire attempts settle before asserting on ordering. */
const tick = () => new Promise((r) => setTimeout(r, 10));

/** Await a rejection and return it, so its identity/shape can be asserted. */
function rejected(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err,
  );
}

describe("withKeyedLock", () => {
  it("serializes same-key callers in FIFO order", async () => {
    const order: number[] = [];
    const gates = [defer(), defer(), defer()];
    const runs = [
      withKeyedLock("k", async () => {
        order.push(0);
        await gates[0].promise;
      }),
      withKeyedLock("k", async () => {
        order.push(1);
        await gates[1].promise;
      }),
      withKeyedLock("k", async () => {
        order.push(2);
        await gates[2].promise;
      }),
    ];
    await tick();
    // Only the first caller is inside — the others are queued.
    expect(order).toEqual([0]);
    gates[0].resolve();
    await runs[0];
    await tick();
    expect(order).toEqual([0, 1]);
    gates[1].resolve();
    await runs[1];
    await tick();
    expect(order).toEqual([0, 1, 2]);
    gates[2].resolve();
    await Promise.all(runs);
  });

  it("never blocks different keys", async () => {
    const gate = defer();
    const ran: string[] = [];
    const first = withKeyedLock("a", async () => {
      await gate.promise;
      ran.push("a-released");
    });
    await tick(); // let "a" enter and block on its gate
    // "b" completes even though "a" still holds its gate.
    await expect(withKeyedLock("b", async () => { ran.push("b"); })).resolves.toBeUndefined();
    expect(ran).toEqual(["b"]);
    gate.resolve();
    await first;
    expect(ran).toEqual(["b", "a-released"]);
  });

  it("releases the lock when fn rejects — the next waiter proceeds", async () => {
    const boom = withKeyedLock("k", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    // The lock was freed despite the rejection.
    await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("a newcomer arriving after release waits for the admitted waiter (no barging)", async () => {
    const order: string[] = [];
    const gate = defer();
    const first = withKeyedLock("k", async () => {
      order.push("first");
      await gate.promise;
    });
    const second = withKeyedLock("k", async () => {
      order.push("second");
    });
    await tick();
    const third = withKeyedLock("k", async () => {
      order.push("third");
    });
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  describe("bounded waiting (#153)", () => {
    it("rejects a waiter parked past waitTimeoutMs with the typed wait-timeout error", async () => {
      const gate = defer();
      const holder = withKeyedLock("k", async () => {
        await gate.promise;
      });
      const waiter = withKeyedLock(
        "k",
        async () => {
          throw new Error("must not run");
        },
        { waitTimeoutMs: 50 },
      );
      const err = (await rejected(waiter)) as KeyedLockUnavailableError;
      expect(err).toBeInstanceOf(KeyedLockUnavailableError);
      expect(err.reason).toBe("wait-timeout");
      expect(err.code).toBe("KEYED_LOCK_UNAVAILABLE");
      expect(err.message).toContain("timed out");
      // The holder is unaffected, and the lock works again after release.
      gate.resolve();
      await holder;
      await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
    });

    it("a timed-out waiter is removed from the queue and never receives a later handoff", async () => {
      const gate = defer();
      const holder = withKeyedLock("k", async () => {
        await gate.promise;
      });
      const doomed = withKeyedLock("k", () => Promise.resolve("doomed"), { waitTimeoutMs: 50 });
      const survivor = withKeyedLock("k", () => Promise.resolve("survivor"));
      await tick(); // both queued behind the holder
      const err = (await rejected(doomed)) as KeyedLockUnavailableError;
      expect(err.reason).toBe("wait-timeout");
      // The abandoned waiter must not still sit in the queue: the next
      // release hands the lock to the survivor, not to the corpse (that
      // would strand the lock on a caller that already saw the failure).
      gate.resolve();
      await holder;
      await expect(survivor).resolves.toBe("survivor");
      // And the lock is genuinely free once the survivor releases.
      await expect(withKeyedLock("k", () => Promise.resolve("next"))).resolves.toBe("next");
    });

    it("an admitted waiter is unaffected by its own timeout window passing while it runs", async () => {
      const gate = defer();
      const holder = withKeyedLock("k", async () => {
        await gate.promise;
      });
      // Admitted well before its 50ms timer would have fired, then holds
      // the lock PAST that mark — admission must cancel the timeout.
      const waiter = withKeyedLock(
        "k",
        async () => {
          await new Promise((r) => setTimeout(r, 80));
          return "ran";
        },
        { waitTimeoutMs: 50 },
      );
      await tick();
      gate.resolve();
      await holder;
      await expect(waiter).resolves.toBe("ran");
      await expect(withKeyedLock("k", () => Promise.resolve("free"))).resolves.toBe("free");
    });

    it("fails fast beyond maxWaiters with the typed queue-full error", async () => {
      const gate = defer();
      const holder = withKeyedLock("k", async () => {
        await gate.promise;
      });
      const waiters = Array.from({ length: DEFAULT_MAX_LOCK_WAITERS }, () =>
        withKeyedLock("k", () => Promise.resolve("w")),
      );
      const overflow = withKeyedLock("k", () => Promise.resolve("overflow"));
      const err = (await rejected(overflow)) as KeyedLockUnavailableError;
      expect(err).toBeInstanceOf(KeyedLockUnavailableError);
      expect(err.reason).toBe("queue-full");
      expect(err.message).toContain("full");
      // The queued waiters were untouched by the failed arrival — FIFO
      // handoff still drains them in order once the holder releases.
      gate.resolve();
      await holder;
      await Promise.all(waiters);
      await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
    });

    it("honors per-call bounds: a custom maxWaiters only gates arrivals configured with it", async () => {
      const gate = defer();
      const holder = withKeyedLock("k", async () => {
        await gate.promise;
      });
      const w1 = withKeyedLock("k", () => Promise.resolve(1));
      const w2 = withKeyedLock("k", () => Promise.resolve(2));
      const overflow = withKeyedLock("k", () => Promise.resolve(3), { maxWaiters: 2 });
      const err = (await rejected(overflow)) as KeyedLockUnavailableError;
      expect(err.reason).toBe("queue-full");
      gate.resolve();
      await holder;
      expect(await w1).toBe(1);
      expect(await w2).toBe(2);
      await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
    });

    it("FIFO handoff still holds with both bounds armed", async () => {
      const order: string[] = [];
      const gate = defer();
      const opts = { waitTimeoutMs: 500, maxWaiters: 4 };
      const holder = withKeyedLock(
        "k",
        async () => {
          order.push("holder");
          await gate.promise;
        },
        opts,
      );
      const a = withKeyedLock(
        "k",
        async () => {
          order.push("a");
        },
        opts,
      );
      const b = withKeyedLock(
        "k",
        async () => {
          order.push("b");
        },
        opts,
      );
      await tick();
      expect(order).toEqual(["holder"]);
      gate.resolve();
      await Promise.all([holder, a, b]);
      expect(order).toEqual(["holder", "a", "b"]);
    });

    it("waitTimeoutMs: Infinity waits indefinitely (the pre-bounds behavior, opt-in)", async () => {
      const gate = defer();
      const holder = withKeyedLock("k", async () => {
        await gate.promise;
      });
      const waiter = withKeyedLock("k", () => Promise.resolve("patient"), {
        waitTimeoutMs: Infinity,
      });
      await tick();
      gate.resolve();
      await holder;
      await expect(waiter).resolves.toBe("patient");
    });

    it("defaults arm both bounds (30s timeout, 32 waiters) and don't misfire on short waits", async () => {
      expect(DEFAULT_LOCK_WAIT_TIMEOUT_MS).toBe(30_000);
      expect(DEFAULT_MAX_LOCK_WAITERS).toBe(32);
      const holder = withKeyedLock("k", async () => {
        await new Promise((r) => setTimeout(r, 120));
      });
      // A no-options waiter rides out a 120ms hold — the 30s default is
      // nowhere near firing on realistic contention.
      await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
      await holder;
    });

    it("rejects nonsense bounds loudly instead of silently failing every contended acquire", async () => {
      await expect(
        withKeyedLock("k", () => Promise.resolve("x"), { waitTimeoutMs: 0 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        withKeyedLock("k", () => Promise.resolve("x"), { waitTimeoutMs: -1 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        withKeyedLock("k", () => Promise.resolve("x"), { waitTimeoutMs: Number.NaN }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        withKeyedLock("k", () => Promise.resolve("x"), { maxWaiters: 0 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        withKeyedLock("k", () => Promise.resolve("x"), { maxWaiters: 2.5 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        withKeyedLock("k", () => Promise.resolve("x"), { maxWaiters: Number.NaN }),
      ).rejects.toBeInstanceOf(RangeError);
      // The failed validations never touched the lock — a clean acquire
      // still works for the key.
      await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
    });
  });
});
