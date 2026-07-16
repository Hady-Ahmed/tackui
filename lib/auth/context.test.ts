import { describe, it, expect } from "vitest";
import { getCurrentUser, getRequestUser } from "./context";
import { getRunnerUser, runWithUser, type RequestUser } from "./request-context";

const testUser: RequestUser = {
  id: "test-user-id",
  role: "admin",
  name: "Test User",
  email: "test@example.com",
};

describe("AUTH_DISABLED mode (set in vitest.setup.ts)", () => {
  it("getCurrentUser returns synthetic admin", async () => {
    const user = await getCurrentUser();
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
    expect(user!.id).toBe("local");
  });

  it("getRequestUser returns synthetic admin for any request", async () => {
    const request = new Request("http://localhost/api/test");
    const user = await getRequestUser(request);
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
  });
});

describe("AsyncLocalStorage (request-context)", () => {
  it("getRunnerUser returns null outside ALS context", () => {
    expect(getRunnerUser()).toBeNull();
  });

  it("runWithUser sets the user for sync callbacks", () => {
    const result = runWithUser(testUser, () => getRunnerUser());
    expect(result).toEqual(testUser);
  });

  it("runWithUserAsync sets the user for async callbacks", async () => {
    const { runWithUserAsync } = await import("./request-context");
    const result = await runWithUserAsync(testUser, async () => {
      return getRunnerUser();
    });
    expect(result).toEqual(testUser);
  });

  it("getRunnerUser is cleared after runWithUser scope exits", () => {
    runWithUser(testUser, () => {
      expect(getRunnerUser()).toEqual(testUser);
    });
    expect(getRunnerUser()).toBeNull();
  });

  it("nested ALS contexts work correctly", () => {
    const innerUser: RequestUser = { ...testUser, id: "inner-user" };
    runWithUser(testUser, () => {
      expect(getRunnerUser()?.id).toBe("test-user-id");
      runWithUser(innerUser, () => {
        expect(getRunnerUser()?.id).toBe("inner-user");
      });
      expect(getRunnerUser()?.id).toBe("test-user-id");
    });
  });
});
