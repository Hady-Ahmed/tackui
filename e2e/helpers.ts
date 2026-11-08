/**
 * E2E admin — the platform admin role, the session cookie jar, and the
 * console-error watcher every test uses. The fixtures are the same objects
 * the app's real auth issues: the admin logs in through the real login
 * page (better-auth's own email/password flow), so the session cookie is
 * the genuine one.
 */
import { expect, type Page } from "@playwright/test";

export const E2E_ADMIN_EMAIL = "e2e-admin@test.local";
export const E2E_ADMIN_PASSWORD = "e2e-admin-password";

/**
 * Log in through the real login page. The test asserts the redirect to
 * /app — the app's own session-cookie contract — not a faked cookie.
 */
export async function login(page: Page) {
  await page.goto("/login");
  // exact: placeholder matching is substring by default — "Email" would
  // also match a renamed "Broken Email Field", blinding the canary.
  await page.getByPlaceholder("Email", { exact: true }).fill(E2E_ADMIN_EMAIL);
  await page.getByPlaceholder("Password", { exact: true }).fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/app/);
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
