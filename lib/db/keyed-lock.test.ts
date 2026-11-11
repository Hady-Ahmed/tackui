import { describe, it, expect } from "vitest";
import { withKeyedLock } from "./keyed-lock";

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let queued acquire attempts settle before asserting on ordering. */
const tick = () => new Promise((r) => setTimeout(r, 10));

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
});
