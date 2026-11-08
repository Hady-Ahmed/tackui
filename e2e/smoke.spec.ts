/**
 * Tier 1 E2E smoke suite — the CI canary that proves the app actually
 * runs: the built Next.js server boots, the surfaces render, and the two
 * most important journeys (login, chat) work end-to-end. Each test is a
 * user journey, not a screenshot — "can a user do the thing," against the
 * real app (standalone build), real Postgres (throwaway container), real
 * auth (better-auth session cookies). Only the model is fake (the mock
 * AG-UI agent), so runs are deterministic, fast, and free.
 *
 * Depth: Tier 1. Every surface gets a canary (renders + no console
 * errors); the two critical journeys (login, chat) get full assertions.
 * Deeper journeys belong in Tier 2 (see docs/e2e.md) — don't grow this
 * file into them.
 */
import { test, expect } from "@playwright/test";
import { login, watchConsoleErrors } from "./helpers";

test.describe("smoke — boot", () => {
  // The app is up (web-server.mjs waited for readiness) — the boot
  // canary: login page renders, no console errors.
  test("login page renders", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await page.goto("/login");
    // exact: substring matching would let a renamed placeholder ("Broken
    // Email Field") still satisfy "Email" — the canary must be deaf to that.
    await expect(page.getByPlaceholder("Email", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("health endpoint answers", async ({ request }) => {
    const res = await request.get("/api/health?deep=true");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
  });
});

test.describe("smoke — login journey", () => {
  test("login works and the session persists on reload", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    // The chat page renders with the seeded agent.
    await expect(page.getByText("E2E Mock Agent").first()).toBeVisible();
    // Session persists — the better-auth cookie is real. A full reload
    // (not a client-side nav) exercises the cookie gate in proxy.ts.
    await page.reload();
    await expect(page.getByPlaceholder("Type a message...", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("smoke — chat journey", () => {
  test("sending a message completes a run against the mock agent", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);

    // Select the seeded agent if it isn't already active.
    await page.getByText("E2E Mock Agent").first().click();

    // Send a message — the real run path: /api/copilotkit → registry →
    // mock AG-UI agent → SSE events → CopilotKit → the assistant bubble.
    const input = page.getByPlaceholder("Type a message...", { exact: true });
    await input.fill("Hello from the smoke suite");
    await input.press("Enter");

    // The mock agent's fixed reply renders — the run completed.
    await expect(page.getByText("E2E mock agent reply")).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  });
});

test.describe("smoke — surfaces render", () => {
  test("agent list renders", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.goto("/agents");
    await expect(page.getByText("E2E Mock Agent").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("catalog renders", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.goto("/app/catalog");
    // The catalog page renders its header + the empty state (the seeded
    // DB has no templates — a fresh install is the documented empty
    // state: "The catalog is empty").
    await expect(page.getByRole("heading", { name: "Agent catalog" })).toBeVisible();
    await expect(page.getByText(/catalog is empty/i)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("builder renders", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.goto("/agents");
    await expect(page.getByRole("button", { name: /add agent/i })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("platform admin renders", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.goto("/admin");
    // The admin page is gated to platform admins — the seed admin is one.
    await expect(page.getByText(/models & tools/i)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
