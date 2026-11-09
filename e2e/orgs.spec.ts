/**
 * Tier 2C E2E — orgs, invitations, member visibility (#103): the first
 * multi-user journey. Everything before this ran as the single seeded
 * admin; this spec drives the REAL invite → accept handoff across two
 * isolated browser contexts (separate cookie jars — no session leakage)
 * and asserts the org scoping that memberships exist to provide.
 * Same harness and conventions as smoke/chat/agents (docs/e2e.md): real
 * built app, throwaway Postgres, real better-auth sessions, mock AG-UI
 * agent — only the model is faked.
 *
 * The journey:
 * 1. The owner (seed admin) creates one probe thread in their workspace,
 *    then invites the seeded second user by email through the real
 *    invite dialog (account menu → "Invite member"). The pending
 *    invitation shows on /app/members.
 * 2. The member (seeded, pre-verified, plain user) logs in — their first
 *    session ever, so the app's session hook creates their personal
 *    workspace on it. Before accepting they see NONE of the owner's org:
 *    no workspace agents on /agents, no probe thread in the chat
 *    surface. The pending invitation surfaces via the account-menu
 *    badge.
 * 3. The member accepts through the real acceptance UI (/app/invitations
 *    → Accept → authClient.organization.acceptInvitation) and switches
 *    into the owner's workspace with the org switcher. The workspace
 *    agent appears (membership is real), the owner's probe thread does
 *    NOT (threads are scoped per user inside the org), and the member's
 *    own probe thread is created by a real chat run.
 * 4. Back as the owner: the roster on /app/members shows the member with
 *    the role the UI exposes ("member"), the owner's probe thread is
 *    still theirs alone (the member's probe is invisible), and the
 *    invitation is no longer pending.
 *
 * Email reality (docs/auth-and-orgs.md): when this spec was built the
 * harness set no mail provider, so better-auth's `sendInvitationEmail`
 * was undefined — the app's own no-email discovery path (badge →
 * /app/invitations → Accept) was the journey under test. Since 2E
 * (#107) the harness runs a local mail catcher (RESEND_BASE_URL →
 * e2e/email-catcher.mjs), so an invitation email is delivered there
 * too; nothing here reads it, and nothing is stubbed or forged — the
 * invitation id still travels through the authenticated
 * listUserInvitations response, and the acceptance is the genuine UI
 * flow.
 *
 * Auth budget: better-auth caps sign-in at 10/min per IP
 * (lib/auth/auth.ts). This file spends TWO real logins — one per user,
 * both in beforeAll through `login()`/`loginAs()` (the shared pacer;
 * never an unpaced path), because a two-session journey is the honest
 * minimum. See docs/e2e.md "The auth budget".
 *
 * Hard rule — parallel mutation (docs/e2e.md): create-own / mutate-own /
 * delete-own. Every row this spec touches it created itself: two probe
 * threads (unique per run), the invitation, and the membership. The
 * seeded second user is by definition shared fixture — created in the
 * seed like the admin, only ever logged into here. No teardown: each
 * run reseeds a fresh database, and the artifacts are inert to other
 * specs (the member's thread is invisible to the admin per-user; the
 * membership only widens a roster nothing else reads).
 */
import {
  test,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  E2E_MEMBER_EMAIL,
  E2E_MEMBER_PASSWORD,
  login,
  loginAs,
  watchConsoleErrors,
} from "./helpers";

/** The session state one real login produced, reused by each test's
 * fresh context (the cookies the real login issued — nothing faked). */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let adminSession: StorageState;
let memberSession: StorageState;

// One worker runs all four tests back-to-back: the two beforeAll logins
// cover them, and the journey's mutations never interleave with anything
// else this file does.
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  // The owner — the seed admin. Paced sign-in slot one of this file's two.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);
    adminSession = await page.context().storageState();
    await context.close();
  }
  // The member — the seeded second user's FIRST login, in its own
  // context: the personal workspace the app's session hook creates on it
  // is part of the journey under test. Paced slot two.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD);
    memberSession = await page.context().storageState();
    await context.close();
  }
});

/** The mock agent's fixed reply text (e2e/mock-agent.mjs). */
const MOCK_REPLY = "E2E mock agent reply";

/** Shared seeded fixtures — read-only for this spec. */
const SEEDED_AGENT_NAME = "E2E Mock Agent";
/** The owner's workspace — the invitation's target org (seed name). */
const OWNER_ORG_NAME = "E2E Admin's workspace";

/** A unique per-run probe title (workers share one DB; the sidebar lists
 * threads by the first user message, truncated at 50 chars). */
function probe(title: string): string {
  return `${title} ${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}
const OWNER_THREAD = probe("Owner probe");
const MEMBER_THREAD = probe("Member probe");

/** Send a message through the real chat input (same flow as
 * e2e/chat.spec.ts). */
async function send(page: Page, text: string) {
  const input = page.getByPlaceholder("Type a message...", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

/** The run is fully settled: the sidebar conversation (titled with the
 * first user message) appears when the client refetches threads on run
 * finalization — strictly after the server persisted the run. The
 * desktop sidebar is the first <aside>; the mobile drawer duplicates it
 * hidden behind md:hidden (the same first()-narrowing smoke uses). */
async function expectRunSettled(page: Page, firstUserMessage: string) {
  const sidebar = page.locator("aside").first();
  await expect(
    sidebar.getByText(firstUserMessage, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

/** The account-menu trigger in the expanded sidebar. Not exact: the
 * button's accessible name folds the display name and the email into
 * one string, so the email is the unambiguous part. */
function accountMenuButton(page: Page, email: string) {
  return page.getByRole("button", { name: new RegExp(email.replace(/\./g, "\\.")) });
}

/** The desktop /agents table row for one agent (the mobile card list is
 * hidden at the suite's viewport). */
function agentRow(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

/**
 * Console errors the agent-less-workspace state legitimately produces:
 * the CopilotKit provider's runtime-info auto-detect fails BY DESIGN
 * there — the registry throws "No agents are set up in this workspace
 * yet." (lib/agents/registry.ts, the run path's user-facing message),
 * the runtime's info handler wraps any factory throw as a 500, and the
 * client's single-route POST fallback then 404s — one console.error per
 * agent-less /app mount. The UI's own empty state is the honest surface
 * (asserted separately). Used ONLY where the test's subject includes the
 * agent-less workspace (the member before accepting / mid-switch);
 * T1/T4 and every other spec assert console-clean unfiltered, so a
 * runtime-info failure on any agent-full page stays a red signal.
 */
function agentlessWorkspaceConsoleNoise(errors: string[]): string[] {
  return errors.filter((e) => !/runtime_info_fetch_failed/.test(e));
}

test("the owner invites the member by email through the account menu", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // Owner-side fixture first: one real probe thread in the org — the
  // later tests assert the member never sees it.
  await page.goto("/app");
  // Not exact: the sidebar row renders the name and the description as
  // separate text nodes inside one button (same narrowing smoke uses).
  await page.getByText(SEEDED_AGENT_NAME).first().click();
  await send(page, OWNER_THREAD);
  await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 30_000 });
  await expectRunSettled(page, OWNER_THREAD);

  // Cancel any pending invitation this file's own earlier attempt left
  // behind (CI retries a failed test once) so exactly one is sent —
  // cancel-own before create-own.
  await page.goto("/app/members");
  // Scoped to a pending-invitation row by its own status badge, NOT the
  // email text alone: once the member has JOINED (a serial re-run from
  // T1 after T3 accepted), the members roster renders their email too
  // (app/app/members/page.tsx) and a text-only match would enter the
  // loop and hang clicking a Cancel button the roster row doesn't have.
  // The badge also beats the obvious alternative — filtering by the
  // Cancel-invite affordance — because the click relabels that button to
  // "Cancelling…" while the request is in flight, dropping the row out
  // of an affordance-scoped locator and letting the loop's exit check
  // pass before the server has actually cancelled (the re-invite below
  // would then race the stale invitation). The badge persists through
  // the in-flight state, so toHaveCount(0) below only passes once the
  // row is really gone. The roster never renders "pending" (its badges
  // are roles), and this spec is the only writer of this org's invites.
  const pendingRow = page
    .locator("ul li")
    .filter({ hasText: E2E_MEMBER_EMAIL })
    .filter({ has: page.getByText("pending", { exact: true }) });
  // When the member has already joined, no invitation is pending, the
  // filter matches nothing and this loop no-ops — the re-invite below
  // then fails fast (better-auth rejects an invite addressed to an
  // existing member) instead of spinning into the test timeout.
  while (await pendingRow.count()) {
    await pendingRow
      .first()
      .getByRole("button", { name: "Cancel invite", exact: true })
      .click();
    await expect(pendingRow).toHaveCount(0);
  }

  // The real invite dialog — the self-host copy (seats are unlimited
  // with billing off) pins the seats-null path too.
  await page.goto("/app");
  await accountMenuButton(page, "e2e-admin@test.local").click();
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Invite member", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Anyone invited will join this workspace.", { exact: true }),
  ).toBeVisible();
  await page
    .getByPlaceholder("teammate@example.com", { exact: true })
    .fill(E2E_MEMBER_EMAIL);
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  // The success banner replaces the form (role defaults to Member — the
  // members page below pins the role it was sent with). The success
  // state renders no close button; the hard navigation below dismisses
  // the dialog with the page.
  await expect(page.getByText(/Invitation sent to/)).toBeVisible();

  // The pending invitation is visible to the owner on the members page —
  // addressed to the member, with the role and status the UI exposes.
  await page.goto("/app/members");
  await expect(pendingRow).toBeVisible();
  await expect(
    pendingRow.getByText("Invited as member", { exact: true }),
  ).toBeVisible();
  await expect(pendingRow.getByText("pending", { exact: true })).toBeVisible();
  await expect(
    pendingRow.getByRole("button", { name: "Cancel invite", exact: true }),
  ).toBeVisible();

  expect(errors).toEqual([]);
  await context.close();
});

test("before accepting, the member sees none of the owner's org", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: memberSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // The member's fresh personal workspace: agents are org-scoped, and
  // the owner's workspace agent is on the other side of the boundary.
  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No agents yet — new ones appear in the chat sidebar immediately.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(SEEDED_AGENT_NAME, { exact: true })).toHaveCount(0);

  // The chat surface: no agents → no conversations UI at all, so the
  // owner's probe thread is nowhere in the member's session.
  await page.goto("/app");
  await expect(page.getByText("No agents yet.", { exact: true })).toBeVisible();
  await expect(page.getByText(OWNER_THREAD, { exact: true })).toHaveCount(0);

  // The invitation surfaces through the app's own no-email discovery
  // path: the account-menu badge (count 1) → /app/invitations.
  await accountMenuButton(page, "e2e-member@test.local").click();
  const badge = page.getByRole("button", {
    name: "Pending invitations 1",
    exact: true,
  });
  await expect(badge).toBeVisible();

  expect(agentlessWorkspaceConsoleNoise(errors)).toEqual([]);
  await context.close();
});

test("the member accepts the invitation and joins the owner's workspace", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: memberSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // The real acceptance UI (the badge's target): the pending card names
  // the workspace and the role it was sent with. Accept runs the
  // authenticated acceptInvitation — the membership is created
  // server-side by better-auth.
  await page.goto("/app/invitations");
  const invite = page.locator("ul li").filter({ hasText: OWNER_ORG_NAME });
  await expect(invite).toBeVisible();
  await expect(
    invite.getByText("Invited as member", { exact: true }),
  ).toBeVisible();
  await invite.getByRole("button", { name: "Accept", exact: true }).click();

  // Accepted → the pending list empties. Not exact: the empty-state
  // paragraph also contains the "Back to chat" link text.
  await expect(invite).toHaveCount(0);
  await expect(page.getByText("No pending invitations.")).toBeVisible();

  // better-auth's acceptance auto-activates the invited workspace — the
  // switcher (self-rendering now that the member belongs to two) already
  // names it, so joining needs no extra step.
  // Scoped to the header: the empty state renders its own second
  // "Back to chat" link (both target /app).
  await page
    .getByRole("banner")
    .getByRole("link", { name: "Back to chat" })
    .click();
  await accountMenuButton(page, "e2e-member@test.local").click();
  // Not exact: the switcher folds the plan badge into its accessible name.
  await expect(
    page.getByRole("button", { name: /E2E Admin's workspace/ }),
  ).toBeVisible();

  // The workspace agent is now visible in the member's session — org
  // scoping with a real membership.
  await page.goto("/agents");
  await expect(agentRow(page, SEEDED_AGENT_NAME)).toBeVisible();

  // The switcher's own affordance, both ways: back to the member's
  // personal workspace — the agent vanishes (visibility follows the
  // active org, not just membership) — then forward again for the chat.
  // (The account menu lives in the chat sidebar; /agents is standalone.)
  await page.goto("/app");
  await accountMenuButton(page, "e2e-member@test.local").click();
  // The closed switcher reads the owner's workspace (not exact: plan
  // badge folded into the name); opening it reveals the workspace rows.
  await page.getByRole("button", { name: /E2E Admin's workspace/ }).click();
  // With the dropdown open, this name can only be the personal-org row —
  // the closed switcher still reads the owner's workspace.
  await page.getByRole("button", { name: /E2E Member's workspace/ }).click();
  // Post-nav settle signal: the member's empty personal workspace has no
  // agents, so the chat area renders its empty state (and no input).
  await expect(page.getByText("No agents yet.", { exact: true })).toBeVisible();

  await accountMenuButton(page, "e2e-member@test.local").click();
  // Symmetric: the closed switcher now reads the personal workspace;
  // opening it and picking the owner's-org row (the only match for this
  // name while the dropdown is open).
  await page.getByRole("button", { name: /E2E Member's workspace/ }).click();
  await page.getByRole("button", { name: /E2E Admin's workspace/ }).click();
  // Post-nav settle signal: the workspace agent auto-selected, so the
  // chat input exists again.
  await expect(
    page.getByPlaceholder("Type a message...", { exact: true }),
  ).toBeVisible();

  // Threads are scoped per user inside the shared org: the owner's probe
  // is not in the member's conversation list — only the member's own
  // probe, created by the real chat run below, is.
  await page.getByText(SEEDED_AGENT_NAME).first().click();
  // Scoped to the desktop sidebar: the hidden mobile drawer duplicates
  // the conversations list (same first()-narrowing expectRunSettled uses).
  await expect(
    page
      .locator("aside")
      .first()
      .getByText("No conversations yet", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(OWNER_THREAD, { exact: true })).toHaveCount(0);
  await send(page, MEMBER_THREAD);
  await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 30_000 });
  await expectRunSettled(page, MEMBER_THREAD);

  // The switch-back deliberately re-entered the member's agent-less
  // personal workspace (see agentlessWorkspaceConsoleNoise).
  expect(agentlessWorkspaceConsoleNoise(errors)).toEqual([]);
  await context.close();
});

test("membership is visible to the owner; threads stay scoped to their creator", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // The owner's conversation list gains nothing from the member: the
  // owner's probe is theirs, the member's probe is invisible — per-user
  // scoping inside the shared org, in both directions. Presence is
  // scoped to the desktop sidebar (the hidden mobile drawer duplicates
  // the list); the absence assertion stays page-wide — absence is
  // absence everywhere.
  await page.goto("/app");
  await page.getByText(SEEDED_AGENT_NAME).first().click();
  await expect(
    page.locator("aside").first().getByText(OWNER_THREAD, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(MEMBER_THREAD, { exact: true })).toHaveCount(0);

  // The roster: the member joined with the role the invitation carried,
  // and the owner is marked as the viewer. The pending invitation is no
  // longer pending.
  await page.goto("/app/members");
  const ownerRow = page.locator("ul li").filter({ hasText: "E2E Admin" });
  await expect(ownerRow.getByText("(you)", { exact: true })).toBeVisible();
  await expect(ownerRow.getByText("owner", { exact: true })).toBeVisible();
  const memberRow = page.locator("ul li").filter({ hasText: "E2E Member" });
  await expect(memberRow).toBeVisible();
  await expect(memberRow.getByText("member", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pending invitations", exact: true }),
  ).toHaveCount(0);

  expect(errors).toEqual([]);
  await context.close();
});
