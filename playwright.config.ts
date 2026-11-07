/**
 * Playwright config — Tier 1 E2E smoke suite.
 *
 * The webServer is e2e/web-server.mjs: it owns the full lifecycle (Postgres
 * container → migrations → seed → mock AG-UI agent → built app), so the
 * single command is the whole stack. The suite runs against the REAL built
 * app (the standalone build the Dockerfile ships) — that's the point: CI
 * green here means the app actually boots and the core journeys work.
 *
 * npm scripts:
 *   test:e2e        — build + run the smoke suite (full CI path)
 *   test:e2e:local  — skip the build (reuse an existing .next/standalone)
 *   test:e2e:headed — run with a visible browser (local debugging)
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_APP_PORT || 3990);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // The smoke suite is a canary: one file, ~8 tests. Keep it strict —
  // a failing test must fail the suite, not hang.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Headless chromium — the same engine the ad-hoc browser verifications
    // used. The app's CSP allows 'self' scripts; the app pages are plain
    // React — no cross-origin concerns.
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "node e2e/web-server.mjs",
    url: `${baseURL}/api/health?deep=true`,
    reuseExistingServer: !process.env.CI,
    // The build is done OUTSIDE the webServer command (npm run test:e2e
    // builds first) — the webServer command itself only starts the
    // compiled app + the stack. The generous timeout covers the
    // Postgres container start + migrations + boot.
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
