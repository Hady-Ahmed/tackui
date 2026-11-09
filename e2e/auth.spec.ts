/**
 * Tier 2E E2E — auth journeys (#107): signup, email verification, and
 * password reset — the pure-app better-auth journeys the Tier 1
 * login-only coverage left out. Same harness and conventions as
 * smoke/chat/agents/orgs (docs/e2e.md): real built app, throwaway
 * Postgres, real better-auth sessions — only the model is faked, and
 * now the mail transport's DESTINATION.
 *
 * Email reality (the #107 stop clause, resolved): the harness runs the
 * app with email features ON — web-server.mjs sets a throwaway
 * RESEND_API_KEY (flipping lib/email's EMAIL_ENABLED, which turns on
 * requireEmailVerification + the sendVerificationEmail/sendResetPassword
 * callbacks, exactly as a production deployment with SMTP) and points
 * the Resend SDK's RESEND_BASE_URL at a local catcher
 * (e2e/email-catcher.mjs). Every email the app really sends — through
 * the app's own callback and template code — lands there; the spec
 * picks up the REAL link each email carries and drives it through the
 * real UI. Nothing about the app is stubbed, and no flow is faked:
 * the tokens arrive the way a user receives them, transported locally
 * the way the mock agent transports the model. (A pure DB-driven link
 * is not possible for verification in better-auth 1.6: that token is a
 * signed JWT handed only to the send callback, never stored; the
 * reset token is stored as `reset-password:<token>` in the verification
 * table — but the emailed link is the more faithful artifact for both.)
 *
 * The journeys:
 * 1. Signup is GATED on verification (the harness's requireEmailVerification
 *    is a real config, not decorative): a fresh random signup gets the
 *    check-your-email screen instead of a session; a sign-in before
 *    verification meets the 403 panel with the app's resend affordance
 *    (sendOnSignIn is false — resend is THE recovery path, and it is
 *    exercised: its email lands in the catcher too); the newest emailed
 *    link activates the account through better-auth's real verify
 *    endpoint; the real login page then issues the session and the app
 *    settles on the user's own fresh personal workspace.
 * 2. A tampered token cannot verify: better-auth's verifier rejects and
 *    redirects to the failure screen — the negative half of the journey
 *    (no session, no verified flag) that only a red-or-green test can
 *    pin.
 * 3. Password reset for the user THIS FILE created (the hard rule: the
 *    seeded admin's password is never touched): the real forgot-password
 *    form requests it (its anti-enumeration confirmation renders
 *    regardless), the emailed link's token is validated server-side
 *    against the verification row better-auth created, the reset form
 *    sets the new password, and the replacement is asserted in BOTH
 *    directions — the old password stops working (paced rejected
 *    sign-in), the new one signs in through the real login page.
 *
 * Auth budget (docs/e2e.md): this file spends FOUR paced sign-in
 * attempts — two expected-rejection gate checks (the unverified 403, the
 * old-password refusal) and two real logins (post-verification, and with
 * the rotated password) — through `rejectedSignIn`/`loginAs`, plus ONE
 * signup (the /sign-up/email cap stays at 5/min). There is no beforeAll
 * login: every journey here IS a login-boundary journey and creates its
 * own session through the real flows.
 *
 * Hard rule — parallel mutation (docs/e2e.md): create-own / mutate-own.
 * The only rows this spec touches are the ones its own signup created
 * (a unique random email per test execution — a CI retry re-runs the
 * test and gets a fresh identity, never colliding with seed data, whose
 * users and agent are read-only to this file). No teardown: a fresh DB
 * is seeded per run, and the leftovers (one personal workspace per
 * attempt, its verification rows, the catcher's spool) are read by
 * nobody.
 */
import { test, expect, type Page } from "@playwright/test";
import { loginAs, rejectedSignIn, watchConsoleErrors } from "./helpers";
import { catchEmail, emailLink } from "./mailbox";

// One worker runs the three tests back-to-back: the reset journey (test
// 3) resets the account the signup journey (test 1) created, and the
// module state below is that handoff.
test.describe.configure({ mode: "serial" });

/** The account the signup journey created, handed to the reset journey. */
interface JourneyUser {
  email: string;
  password: string;
  newPassword: string;
}
let journeyUser: JourneyUser | null = null;
function theJourneyUser(): JourneyUser {
  if (!journeyUser) {
    throw new Error(
      "the signup journey must run first — serial mode guarantees the order",
    );
  }
  return journeyUser;
}

/** Subject lines the app's own templates emit (lib/email/templates.ts). */
const VERIFY_SUBJECT = "Verify your email address";
const RESET_SUBJECT = "Reset your password";

/** Passwords for the created account — ≥8 chars (the schema floor), and
 * distinct: the reset journey rotates one into the other. */
const ORIGINAL_PASSWORD = "e2e-auth-original-password-0123";
const ROTATED_PASSWORD = "e2e-auth-rotated-password-0123";

/** A fresh identity, generated INSIDE the test: a CI retry re-runs this
 * test with a new address (better-auth's duplicate-email response is
 * deliberately identical to the fresh path, so a reused address could
 * silently verify the FIRST attempt's account and lie about the gate). */
function freshIdentity(): { name: string; email: string } {
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    name: `E2E Auth ${suffix}`,
    email: `e2e-auth-${suffix}@test.local`,
  };
}

/** The fresh user's own personal workspace has no agents, so the /app
 * chat surface shows the empty state — the same settled signal the orgs
 * spec uses for an agent-less workspace. And like there, the empty
 * state legitimately produces one console error (the CopilotKit
 * provider's runtime-info auto-detect fails BY DESIGN — see
 * e2e/orgs.spec.ts's identical, reviewed filter). */
function agentlessWorkspaceConsoleNoise(errors: string[]): string[] {
  return errors.filter((e) => !/runtime_info_fetch_failed/.test(e));
}

/** The fresh user's account-menu trigger on /app: its accessible name
 * folds the display name and the email into one string (the orgs spec's
 * accountMenuButton pattern; the random address is the unambiguous part). */
function accountMenuButton(page: Page, email: string) {
  return page.getByRole("button", {
    name: new RegExp(email.replace(/[.@]/g, "\\$&")),
  });
}

test("signup is gated on verification, and the emailed link activates the account", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  const { name, email } = freshIdentity();
  journeyUser = { email, password: ORIGINAL_PASSWORD, newPassword: ROTATED_PASSWORD };

  // The real /signup form.
  await page.goto("/signup");
  await page.getByPlaceholder("Name", { exact: true }).fill(name);
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page
    .getByPlaceholder("Password (min 8 characters)", { exact: true })
    .fill(ORIGINAL_PASSWORD);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  // The gate: with email verification required (the harness env), no
  // session is issued at signup — the page shows its check-your-email
  // screen instead of navigating to /app.
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true }),
  ).toBeVisible();

  // The signup's verification email went through the app's real send
  // path (better-auth's signup token → lib/auth/auth.ts's callback →
  // lib/email → the catcher). Its link is the genuine article: the
  // better-auth verify URL with a token parameter.
  const signupMail = await catchEmail(email, (m) => m.subject === VERIFY_SUBJECT);
  const signupLink = emailLink(signupMail, "/verify-email?token=");
  expect(
    new URL(signupLink).searchParams.get("token"),
    "the emailed verification link carries a token",
  ).toBeTruthy();

  // The gate is enforced, not decorative: signing in BEFORE verification
  // meets the app's 403 handling — the amber panel, not a session.
  // (A paced, expected-rejection sign-in: the same limiter charge as any
  // other, via the same pacer — docs/e2e.md "The auth budget".)
  await rejectedSignIn(
    page,
    email,
    ORIGINAL_PASSWORD,
    /Please verify your email address/,
  );

  // sendOnSignIn is false (no auto-send on attempts), so the resend
  // button is the app's own recovery path — click it and the catcher
  // receives a SECOND, independently tokened verification email. The
  // freshest one is the link driven below.
  await page
    .getByRole("button", { name: "Resend verification email", exact: true })
    .click();
  await expect(
    page.getByText("Verification email sent. Check your inbox.", { exact: true }),
  ).toBeVisible();
  const resentMail = await catchEmail(
    email,
    (m) => m.subject === VERIFY_SUBJECT && m.id !== signupMail.id,
  );
  const resentLink = emailLink(resentMail, "/verify-email?token=");
  expect(new URL(resentLink).searchParams.get("token")).toBeTruthy();

  // Drive the real verification URL (better-auth's GET endpoint verifies
  // the token server-side and redirects to the rewritten callbackURL —
  // the app's /verify-email page; no error param is the success render).
  await page.goto(resentLink);
  await expect(
    page.getByRole("heading", { name: "Email verified", exact: true }),
  ).toBeVisible();

  // The activation was real: the same credentials that were refused now
  // sign in through the real login page, the session is the fresh user's
  // (their account menu — trigger and contents — renders under the
  // unique address), and their own personal workspace settles.
  await loginAs(page, email, ORIGINAL_PASSWORD);
  await accountMenuButton(page, email).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No agents yet.", { exact: true })).toBeVisible();

  expect(agentlessWorkspaceConsoleNoise(errors)).toEqual([]);
  await context.close();
});

test("a tampered verification token cannot activate an account", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // better-auth's verifier rejects a fabricated token and redirects to
  // the app's callback with ?error=INVALID_TOKEN — the failure render,
  // which offers the app's resend recovery path. (Nothing is mutated:
  // no user exists for the token to attach to.)
  await page.goto(
    "/api/auth/verify-email?token=tampered-by-the-e2e-test&callbackURL=%2Fverify-email",
  );
  await expect(
    page.getByRole("heading", { name: "Verification failed", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resend verification email", exact: true }),
  ).toBeVisible();

  expect(errors).toEqual([]);
  await context.close();
});

test("a password reset through the emailed link replaces the credential", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);
  const { email, password, newPassword } = theJourneyUser();

  // The real forgot-password form — reached through the login page's own
  // link (the emailVerification-gated affordance).
  await page.goto("/login");
  await page
    .getByRole("link", { name: "Forgot password?", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reset your password", exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();

  // Anti-enumeration: the confirmation is identical whether or not the
  // account exists — assert it, then let the catcher provide the real
  // signal (no email → the catchEmail timeout IS the failure).
  await expect(
    page.getByText(/If an account with that email exists/),
  ).toBeVisible();

  // The reset email through the app's real sendResetPassword callback.
  const mail = await catchEmail(email, (m) => m.subject === RESET_SUBJECT);

  // Drive the real reset URL: better-auth's GET /reset-password/:token
  // validates the token against the verification row it created at
  // request time, then redirects to the app's form with the token.
  // Reaching "Set a new password" proves the row validated — a bad token
  // would have redirected to the invalid-link screen instead.
  await page.goto(emailLink(mail, "/reset-password/"));
  await expect(
    page.getByRole("heading", { name: "Set a new password", exact: true }),
  ).toBeVisible();
  await page
    .getByPlaceholder("New password (min 8 characters)", { exact: true })
    .fill(newPassword);
  await page
    .getByPlaceholder("Confirm new password", { exact: true })
    .fill(newPassword);
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();

  // The app routes back to /login — a reset issues no session; the user
  // signs in with the new credential.
  await expect(page).toHaveURL(/\/login/);

  // The replacement, in both directions — two paced sign-in attempts:
  // the old password must STOP working…
  await rejectedSignIn(page, email, password, /Invalid email or password/);
  // …and the new one must open the app (the real login page, a real
  // session, the fresh personal workspace settling).
  await loginAs(page, email, newPassword);
  await expect(page.getByText("No agents yet.", { exact: true })).toBeVisible();

  expect(agentlessWorkspaceConsoleNoise(errors)).toEqual([]);
  await context.close();
});
