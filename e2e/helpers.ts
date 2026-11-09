/**
 * E2E admin — the platform admin role, the session cookie jar, and the
 * console-error watcher every test uses. The fixtures are the same objects
 * the app's real auth issues: the admin logs in through the real login
 * page (better-auth's own email/password flow), so the session cookie is
 * the genuine one.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const E2E_ADMIN_EMAIL = "e2e-admin@test.local";
export const E2E_ADMIN_PASSWORD = "e2e-admin-password";

/**
 * Sign-ins are a shared budget: better-auth caps them at 10/min per IP
 * (lib/auth/auth.ts customRules) and the suite logs in once per real page
 * flow across fullyParallel workers — an ungated burst overflows the
 * limiter's 60s window and the tail tests die in login() (observed when
 * the agent-CRUD file joined the suite, #102). The pacer prevents the
 * burst instead of recovering from it: workers are separate OS processes
 * with no shared lock, so slots are coordinated through the filesystem —
 * a login claims (atomic `wx` create) the next slot ≥ SPACING after the
 * last claimed one and waits for it before touching the login page.
 * 60s window / 7s spacing ⇒ at most 9 sign-ins in any window, so the cap
 * is never tripped and every login still goes through the real page.
 */
const SIGNIN_SPACING_MS = 7_000;
const SIGNIN_DIR = path.join(os.tmpdir(), "tackui-e2e-signin");

/** Claim the next free sign-in slot; resolves to how long to wait until
 * it opens. Losing a claim just means another worker took that slot —
 * aim for the next one. A stale timestamp from an earlier run is always
 * in the past, so it costs nothing. */
async function reserveSigninSlot(): Promise<number> {
  await fs.mkdir(SIGNIN_DIR, { recursive: true });
  const last = await fs
    .readFile(path.join(SIGNIN_DIR, "last"), "utf8")
    .then((raw) => Number(raw) || 0)
    .catch(() => 0);
  let target = Math.max(last + SIGNIN_SPACING_MS, Date.now());
  for (;;) {
    try {
      await fs.writeFile(path.join(SIGNIN_DIR, `slot-${target}`), "", {
        flag: "wx",
      });
      await fs.writeFile(path.join(SIGNIN_DIR, "last"), String(target));
      return Math.max(0, target - Date.now());
    } catch {
      // Slot already claimed — take the next one.
      target += SIGNIN_SPACING_MS;
    }
  }
}

/**
 * Log in through the real login page. The test asserts the redirect to
 * /app — the app's own session-cookie contract — not a faked cookie.
 *
 * Behind the pacer above, the remaining limiter risk is a genuinely
 * transient 429 (a concurrent run sharing the IP): on the rate limiter's
 * "Too many requests" banner it waits a jittered interval and retries
 * (bounded). Jitter keeps workers from retrying in lockstep; anything
 * else — or exhausting the budget — surfaces as the original navigation
 * timeout: a broken login page must fail fast, not be retried into a
 * false pass.
 */
const LOGIN_ATTEMPTS = 3;
const LOGIN_WAIT_URL_MS = 8_000;
const LOGIN_RETRY_MIN_MS = 6_000;
const LOGIN_RETRY_JITTER_MS = 4_000;

export async function login(page: Page) {
  const waitForMs = await reserveSigninSlot();
  if (waitForMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitForMs));
  }
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    // exact: placeholder matching is substring by default — "Email" would
    // also match a renamed "Broken Email Field", blinding the canary.
    await page.getByPlaceholder("Email", { exact: true }).fill(E2E_ADMIN_EMAIL);
    await page.getByPlaceholder("Password", { exact: true }).fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    try {
      await page.waitForURL(/\/app/, { timeout: LOGIN_WAIT_URL_MS });
      break;
    } catch (err) {
      const limited = await page
        .getByText(/too many requests/i)
        .isVisible();
      if (!limited || attempt >= LOGIN_ATTEMPTS - 1) throw err;
      await page.waitForTimeout(
        LOGIN_RETRY_MIN_MS + Math.random() * LOGIN_RETRY_JITTER_MS,
      );
    }
  }
  await expect(page.getByPlaceholder("Type a message...", { exact: true })).toBeVisible();
}

/**
 * Console-error watcher — collects pageerror (uncaught exceptions) and
 * console.error messages. The test asserts no page errors at the end;
 * a failed network request is not a failure (404s on optional assets
 * happen), but an uncaught exception always is.
 */
export function watchConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (err: Error) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg: { type(): string; text(): string }) => {
    if (msg.type() !== "error") return;
    // Browser resource-load noise: the browser logs every 404 as
    // console.error, and the app *expects* some of them (e.g.
    // /api/billing/subscription returns 404 by design when billing
    // isn't configured — the client treats it as "no badge"). A test
    // that needs a specific request to succeed asserts on the UI
    // outcome instead. An uncaught pageerror is always a failure.
    if (/Failed to load resource/.test(msg.text())) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}
