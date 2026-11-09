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
// The seeded second user (e2e/seed.mjs) — the orgs spec's invitee. Kept
// alongside the admin's constants here the same way: fixed, disposable.
export const E2E_MEMBER_EMAIL = "e2e-member@test.local";
export const E2E_MEMBER_PASSWORD = "e2e-member-password";

/**
 * Sign-ins are a shared budget: better-auth caps them at 10/min per IP
 * (lib/auth/auth.ts customRules) and the suite logs in once per real page
 * flow across fullyParallel workers — an ungated burst overflows the
 * limiter's 60s window and the tail tests die in login() (observed when
 * the agent-CRUD file joined the suite, #102). The pacer prevents the
 * burst instead of recovering from it: workers are separate OS processes
 * with no shared lock, so slots are coordinated through the filesystem.
 *
 * A claim is an atomic O_EXCL create of `slot-<T>`, with T snapped to a
 * grid of SIGNIN_SPACING_MS multiples. The grid is what paces the
 * OPENING wave: every worker reads the shared `last` file before any
 * winner has written it, so on a cold or stale dir they all aim at
 * "now" — but now snaps to the same grid point, the O_EXCL create lets
 * exactly one worker win it, and a loser advances a full step and
 * retries. Distinct claims are therefore ≥ SPACING apart however the
 * reads raced, which bounds any 60s window to 9 sign-ins against the
 * 10 cap. (Reconciling `last` upward alone would NOT do it: two cold
 * readers still aim at near-simultaneous but DISTINCT timestamps, both
 * win, both sign at once.) After winning, the claimant reconciles
 * `last` upward to its target so late readers skip straight past
 * settled slots instead of burning failed creates on them — the grid +
 * O_EXCL pair carries the invariant; `last` is only a skip-ahead hint.
 * Slots older than an hour are pruned at claim time so a crashed run
 * leaves no permanent residue, and anything but a lost race is
 * rethrown: a persistent failure must fail loudly, not spin into the
 * test timeout. 60s window / 7s spacing ⇒ at most 9 sign-ins in any
 * window, so the cap is never tripped and every login still goes
 * through the real page.
 */
const SIGNIN_SPACING_MS = 7_000;
const SIGNIN_DIR = path.join(os.tmpdir(), "tackui-e2e-signin");
/** A `last` dated further ahead than this is corruption, not a claim —
 * honest writers date their target at most ~2 grid steps past their own
 * clock. Honoring it would park a worker on an absurd wait. */
const LAST_SANITY_SLACK_MS = 60_000;
/** Contended-claim bound. Every EEXIST is a real competing claim, so a
 * runaway run of them means the shared dir is broken — fail with a name
 * instead of spinning silently into the test timeout. */
const MAX_CLAIM_ATTEMPTS = 1_000;
/** Slot residue older than this is pruned at claim time. */
const SLOT_MAX_AGE_MS = 3_600_000;

/** Snap to the spacing grid (see the module comment for why the grid). */
function gridFloor(ms: number): number {
  return Math.floor(ms / SIGNIN_SPACING_MS) * SIGNIN_SPACING_MS;
}

/** The newest claim on record — or 0 when there is none, the file is
 * unparseable, or it is implausibly future-dated (corruption). A claim
 * is safe on 0: it contends on the grid instead of bursting. */
async function readLastClaim(): Promise<number> {
  return fs
    .readFile(path.join(SIGNIN_DIR, "last"), "utf8")
    .then((raw) => {
      const last = Number(raw) || 0;
      return last > Date.now() + LAST_SANITY_SLACK_MS ? 0 : last;
    })
    .catch(() => 0);
}

/** True only for the one benign claim collision: the slot name is taken. */
function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

/** Prune slot files from runs that ended over an hour ago. Pure hygiene
 * — pacing anchors claims at now, never at old slots — so a failed
 * prune must never fail the run. */
async function pruneStaleSlots(): Promise<void> {
  const cutoff = Date.now() - SLOT_MAX_AGE_MS;
  const names = await fs.readdir(SIGNIN_DIR).catch(() => [] as string[]);
  await Promise.all(
    names
      .map((name) => /^slot-(\d+)$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => Number(m[1]) < cutoff)
      .map((m) =>
        fs.rm(path.join(SIGNIN_DIR, m[0]), { force: true }).catch(() => {}),
      ),
  );
}

/** Claim the next free sign-in slot; resolves to how long to wait until
 * it opens. Losing a claim just means another worker took that slot —
 * aim a full grid step later. */
async function reserveSigninSlot(): Promise<number> {
  await fs.mkdir(SIGNIN_DIR, { recursive: true });
  await pruneStaleSlots();
  const last = await readLastClaim();
  let target = gridFloor(Math.max(last + SIGNIN_SPACING_MS, Date.now()));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(path.join(SIGNIN_DIR, `slot-${target}`), "", {
        flag: "wx",
      });
      break;
    } catch (err) {
      if (!isEexist(err)) {
        // Not contention — a real failure (read-only tmp, ENOSPC, …).
        // Surface it here rather than spinning to the test timeout.
        throw err;
      }
      if (attempt >= MAX_CLAIM_ATTEMPTS) {
        throw new Error(
          `sign-in pacer: ${MAX_CLAIM_ATTEMPTS} contended claim attempts — ${SIGNIN_DIR} looks corrupt`,
        );
      }
      // Slot already claimed — take the next one on the grid.
      target += SIGNIN_SPACING_MS;
    }
  }
  // Reconcile the shared floor upward so workers that read `last` before
  // this claim skip past it. Re-reading immediately before the write
  // keeps an already-higher value from regressing; a write lost to a
  // still-higher concurrent one is harmless — the grid arbitrates the
  // claims themselves.
  const settled = await readLastClaim();
  if (target > settled) {
    await fs
      .writeFile(path.join(SIGNIN_DIR, "last"), String(target))
      .catch(() => {});
  }
  return Math.max(0, target - Date.now());
}

/**
 * Log in as a specific seeded user through the real login page — the
 * shared body behind `login()`. The pacer and the 429 ride-out are the
 * budget for EVERY sign-in in the suite, so the parameterized form exists
 * (multi-user journeys, e2e/orgs.spec.ts) rather than a second,
 * unpaced path. Asserts only the redirect to /app — the app's own
 * session-cookie contract — not a faked cookie.
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
// The redirect wait, not the pacer: the slot was already claimed (the
// wait above) before the form is even submitted. 8s was enough when the
// suite spent 10 logins; at 12 (#103 — the orgs spec logs in two users)
// plus two real chat runs competing for CPU, the tail logins' /app load
// event could miss an 8s window under full-suite load and die WITHOUT
// the 429 banner (so the ride-out below never fired). 15s still fails a
// genuinely broken login page within the 120s test timeout.
const LOGIN_WAIT_URL_MS = 15_000;
const LOGIN_RETRY_MIN_MS = 6_000;
const LOGIN_RETRY_JITTER_MS = 4_000;

export async function loginAs(page: Page, email: string, password: string) {
  const waitForMs = await reserveSigninSlot();
  if (waitForMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitForMs));
  }
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    // exact: placeholder matching is substring by default — "Email" would
    // also match a renamed "Broken Email Field", blinding the canary.
    await page.getByPlaceholder("Email", { exact: true }).fill(email);
    await page.getByPlaceholder("Password", { exact: true }).fill(password);
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
}

/**
 * The seed admin's login: the real page flow, then the chat input — the
 * admin's org always has the seeded agent, so the input is the settled
 * state. The assertion lives HERE and not in `loginAs` because a member
 * with zero agents (the orgs spec's invitee, pre-acceptance) never sees
 * the chat input — their /app shows the "No agents yet." empty state.
 */
export async function login(page: Page) {
  await loginAs(page, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
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
