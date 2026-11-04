import { describe, it, expect } from "vitest";
import {
  runWithUser,
  runWithUserAsync,
  runWithRunnerContext,
  getRunnerUser,
  getRunContextItems,
  getReservedDepKeys,
  type RequestUser,
  type RunContextItem,
} from "./request-context";

const user: RequestUser = {
  id: "user-1",
  role: "user",
  name: "Alice",
  email: "a@test.com",
  orgId: "org-1",
};

const contextItems: RunContextItem[] = [
  { description: "openai_api_key", value: "sk-test" },
];

describe("runWithUser / getRunnerUser", () => {
  it("exposes the user inside the scope", () => {
    runWithUser(user, () => {
      expect(getRunnerUser()).toEqual(user);
    });
  });

  it("returns null outside any scope", () => {
    expect(getRunnerUser()).toBeNull();
  });

  it("restores the outer user after a nested scope exits", () => {
    const outer: RequestUser = { ...user, id: "outer", orgId: "org-outer" };
    const inner: RequestUser = { ...user, id: "inner", orgId: "org-inner" };
    runWithUser(outer, () => {
      runWithUser(inner, () => {
        expect(getRunnerUser()?.id).toBe("inner");
      });
      expect(getRunnerUser()?.id).toBe("outer");
    });
  });

  it("propagates the user across await boundaries (the runner's async chain)", async () => {
    await runWithUserAsync(user, async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(getRunnerUser()?.id).toBe("user-1");
    });
  });
});

describe("runWithRunnerContext", () => {
  it("exposes the stashed deps AND reserved keys inside the scope", async () => {
    await runWithRunnerContext(user, contextItems, ["openai_api_key", "mcp_connectors"], async () => {
      expect(getRunnerUser()).toEqual(user);
      expect(getRunContextItems()).toEqual(contextItems);
      expect(getReservedDepKeys()).toEqual(["openai_api_key", "mcp_connectors"]);
    });
  });

  it("falls back to empty (never undefined) outside a run scope", async () => {
    expect(getRunContextItems()).toEqual([]);
    expect(getReservedDepKeys()).toEqual([]);
  });

  it("keeps the two stores orthogonal: a plain user scope has no deps", () => {
    runWithUser(user, () => {
      expect(getRunnerUser()).toEqual(user);
      expect(getRunContextItems()).toEqual([]);
      expect(getReservedDepKeys()).toEqual([]);
    });
  });

  it("scopes are not shared between concurrent async runs (per-request isolation)", async () => {
    // Two interleaved runner contexts — each async chain must keep seeing
    // ITS OWN deps, which is the whole reason the stash is an ALS and not
    // module state.
    const seen: string[] = [];
    const runOne = (id: string, ms: number) =>
      runWithRunnerContext(
        { ...user, id },
        [{ description: `${id}_api_key`, value: "v" }],
        [`${id}_api_key`],
        async () => {
          await new Promise((r) => setTimeout(r, ms));
          seen.push(getRunContextItems()[0].description);
          seen.push(getReservedDepKeys()[0]);
        },
      );
    await Promise.all([runOne("alpha", 10), runOne("beta", 5)]);
    expect(seen).toEqual(["beta_api_key", "beta_api_key", "alpha_api_key", "alpha_api_key"]);
  });

  it("propagates a rejected fn's error to the caller (the run gate's throw path)", async () => {
    const err = new Error("gate refused");
    await expect(
      runWithRunnerContext(user, contextItems, ["k"], async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("restores outer state after the scope (no leakage into subsequent requests)", async () => {
    await runWithRunnerContext(user, contextItems, ["k"], async () => {
      expect(getReservedDepKeys()).toEqual(["k"]);
    });
    expect(getReservedDepKeys()).toEqual([]);
    expect(getRunContextItems()).toEqual([]);
    expect(getRunnerUser()).toBeNull();
  });
});
