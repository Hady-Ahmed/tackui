/**
 * Tier 2B E2E — agent CRUD (#102): the operator journey the smoke suite
 * only reads. Same harness and conventions as smoke.spec.ts / chat.spec.ts
 * (docs/e2e.md): real built app, throwaway Postgres, real better-auth
 * sessions, mock AG-UI agent — only the model is faked.
 *
 * 1. Create — the real add-agent form (the "Connect an existing agent"
 *    tab: name, endpoint, JWT secret) lands the agent in the /agents
 *    table. The endpoint is the mock agent on loopback; the SSRF guard's
 *    private-endpoint rejection is exercised on purpose and passes
 *    because the harness runs the app with ALLOW_PRIVATE_ENDPOINTS=true.
 * 2. Edit — the write-only jwtSecret semantic: the secret is never
 *    echoed back (GET responses carry hasJwtSecret instead), the edit
 *    form opens with a blank secret field, and a blank submit PATCHes
 *    WITHOUT the secret — the stored value survives. Asserted through
 *    the hasJwtSecret-driven "Key set ✓" hint (it would flip to the
 *    create-variant hint if the blank save wiped the secret) plus the
 *    issue's post-save verification: the connection check succeeds.
 * 3. Test connection — the form's Test connection button runs the real
 *    reachability probe (POST /api/agents/reachability-probe) against
 *    the typed endpoint — not a stub.
 * 4. Delete — the confirm-guarded delete removes the agent from the
 *    list, and only that agent: the seeded agent the smoke suite reads
 *    is untouched.
 *
 * Auth budget: better-auth caps sign-in at 10/min per IP
 * (lib/auth/auth.ts), and the suite spends one login per real page flow.
 * This file therefore runs its four tests SERIALLY in a single worker
 * behind one real login (a `test.beforeAll` hook performs the genuine
 * login-page flow once and stores the session state at module level
 * for each test's fresh context — the cookies are the ones the real
 * login issued; each test still gets its own page, so console-error
 * watching stays per-test).
 * The first test of a growing Tier 2 must not cost four more sign-ins —
 * see docs/e2e.md "The auth budget".
 *
 * Hard rule — parallel mutation (docs/e2e.md): fullyParallel workers
 * share ONE seeded database. create-own / mutate-own / delete-own — every
 * action here targets an agent THIS test created, under a unique random
 * name; the seeded e2e-mock-agent and the seed admin's credentials are
 * only ever read. Each test deletes what it created (asserted), and the
 * third test creates nothing at all (it cancels the form), so a crashed
 * run leaves at most one inert row per test.
 */
import {
  test,
  expect,
  type BrowserContext,
  type Dialog,
  type Page,
} from "@playwright/test";
import { MOCK_AGENT_PORT } from "./mock-agent.mjs";
import { login, watchConsoleErrors } from "./helpers";

/** The session state the file's one real login produced. */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** The session cookies the single real login issued. Set in beforeAll —
 * which runs exactly once here, because the file runs serially in one
 * worker — and reused by every test's fresh context. */
let adminSession: StorageState;

// One worker runs all four tests back-to-back: the single beforeAll
// login below covers them, and the CRUD mutations never interleave with
// each other.
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // The one real login-page flow for this file — the genuine
  // better-auth email/password form, not a faked cookie.
  await login(page);
  adminSession = await page.context().storageState();
  await context.close();
});

/** The mock agent's URL — what every created agent points at. */
const MOCK_ENDPOINT = `http://127.0.0.1:${MOCK_AGENT_PORT}/`;

/** The seeded agent — read-only fixture shared across the suite. */
const SEEDED_AGENT_NAME = "E2E Mock Agent";

/* Placeholder texts of the custom-endpoint form (app/agents/page.tsx).
 * exact: everywhere — substring matching would let a renamed field keep
 * satisfying the old selector (the breakage-test lesson). The edit form
 * swaps the secret placeholder ("at least 32 characters" → "(unchanged)")
 * and swaps the secret hint to the hasJwtSecret variant — both swapped
 * states are asserted below, they ARE the write-only contract's surface. */
const NAME_PLACEHOLDER = "Research Agent";
const DESCRIPTION_PLACEHOLDER = "LangGraph-powered web research assistant";
const ENDPOINT_PLACEHOLDER = "http://localhost:8001/agent";
const CREATE_SECRET_PLACEHOLDER = "at least 32 characters";
const BLANK_SECRET_PLACEHOLDER = "(unchanged)";
/** The edit-form hint rendered only when hasJwtSecret is true. */
const SECRET_SET_HINT =
  "Key set ✓ — leave blank to keep existing, type a new value to replace";
/** The probe's success badge (mock agent answers GET with 405 — the probe
 * accepts any response: reachability, not protocol compliance). */
const REACHABLE_BADGE = /✓ Server reachable \(HTTP \d+\)/;

const DESCRIPTION = "Created and deleted by e2e/agents.spec.ts.";

/** A unique agent name — workers share one DB, so every test mutates
 * only rows it can name unambiguously. */
function uniqueAgentName(): string {
  return `E2E CRUD Agent ${Math.random().toString(36).slice(2, 8)}`;
}

/** A throwaway JWT secret — the schema floor is 32 chars (HS256 ≥ 256
 * bits). Value is never asserted: the write-only contract means the UI
 * must never echo it back. */
function uniqueSecret(): string {
  return `e2e-crud-secret-${Math.random().toString(36).slice(2, 10)}-0123456789abcdef`;
}

/** The desktop table row for one agent (the mobile card list is hidden
 * at the suite's viewport and never asserted on). */
function agentRow(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

/** Open /agents and wait for the table to actually render. The agents
 * GET shares a per-minute budget with every other surface load
 * (`agentRead`, lib/ratelimit/limits.ts) — one user is every test in the
 * suite, and the harness raises that cap (AGENT_READ_RATE_MAX) so the
 * run fits. This is the belt, not the primary: on a transient overflow
 * the page renders its error pane instead of the table, and the page's
 * own Retry button re-fetches — click it (bounded) until rows exist
 * rather than failing. The seed guarantees at least one agent, so "rows
 * exist" is always the loaded state. */
async function openAgents(page: Page) {
  await page.goto("/agents");
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  const firstRow = page.locator("table tbody tr").first();
  await expect(async () => {
    if (await retry.isVisible()) await retry.click();
    await expect(firstRow).toBeVisible();
  }).toPass({ timeout: 20_000 });
}

/**
 * Create a custom-endpoint agent through the real form: open the add
 * panel, flip to the "Connect an existing agent" tab, fill it (endpoint
 * = the mock agent, JWT auth + secret), submit. Resolves once the row is
 * in the table with the saved endpoint — the POST /api/agents +
 * fetchAgents round-trip is complete.
 */
async function createCustomAgent(
  page: Page,
  opts: { name: string; secret: string },
) {
  await page.getByRole("button", { name: "+ Add agent", exact: true }).click();
  // The add panel opens on the builder form; the endpoint/JWT journey
  // lives under the custom tab (org-admin gated — the seed admin is one).
  await page.getByRole("tab", { name: "Connect an existing agent" }).click();

  await page.getByPlaceholder(NAME_PLACEHOLDER, { exact: true }).fill(opts.name);
  await page
    .getByPlaceholder(DESCRIPTION_PLACEHOLDER, { exact: true })
    .fill(DESCRIPTION);
  await page
    .getByPlaceholder(ENDPOINT_PLACEHOLDER, { exact: true })
    .fill(MOCK_ENDPOINT);
  // Selecting the auth mode remounts (and clears) the secret + scopes
  // fields — select first, fill after.
  // Not exact: the wrapping <label> folds the field's hint text into the
  // accessible name, and the hint changes with the selected auth mode —
  // only the "Auth mode" prefix is stable (Field in app/agents/page.tsx).
  await page
    .getByRole("combobox", { name: /^Auth mode/ })
    .selectOption({ label: "JWT (HS256)" });
  await page
    .getByPlaceholder(CREATE_SECRET_PLACEHOLDER, { exact: true })
    .fill(opts.secret);

  await page.getByRole("button", { name: "Create agent", exact: true }).click();

  const row = agentRow(page, opts.name);
  await expect(row).toBeVisible();
  await expect(row).toContainText(MOCK_ENDPOINT);
  return row;
}

/** Open the edit form for one agent and wait for the panel heading. */
async function openEdit(page: Page, name: string) {
  await agentRow(page, name)
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const heading = page.getByRole("heading", {
    name: `Edit ${name}`,
    exact: true,
  });
  await expect(heading).toBeVisible();
  return heading;
}

/**
 * Delete one agent through the UI: row Delete → the real confirm()
 * dialog → accept → row gone. The acceptance and the dialog copy (the
 * destructive action must name its victim) are handled INSIDE the dialog
 * listener: a click that opens a modal does not resolve until the dialog
 * is handled, so awaiting the click first and the dialog after deadlocks
 * both (until the test timeout — observed). Auto-dismissal — Playwright's
 * behavior without a listener — means CANCEL, which would silently
 * abort the delete.
 */
async function deleteOwnAgent(page: Page, name: string) {
  const row = agentRow(page, name);
  let dialogMessage: string | null = null;
  page.once("dialog", (dialog: Dialog) => {
    dialogMessage = dialog.message();
    void dialog.accept();
  });
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  expect(dialogMessage).toBe(
    `Delete agent "${name}"? This cannot be undone.`,
  );
  await expect(row).toHaveCount(0);
}

test("an agent can be created through the add form", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);
  await openAgents(page);

  const name = uniqueAgentName();
  await createCustomAgent(page, { name, secret: uniqueSecret() });

  // Create owns nothing else: the row is asserted inside the helper
  // (name + the saved endpoint). Clean up what this test created.
  await deleteOwnAgent(page, name);
  expect(errors).toEqual([]);
  await context.close();
});

test("editing with a blank secret preserves the stored secret", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);
  await openAgents(page);

  const name = uniqueAgentName();
  await createCustomAgent(page, { name, secret: uniqueSecret() });

  // The edit form is the write-only contract's surface: hasJwtSecret
  // renders the "Key set ✓" hint, and the secret field itself opens
  // blank — the stored value is never echoed back.
  const heading = await openEdit(page, name);
  const secretInput = page.getByPlaceholder(BLANK_SECRET_PLACEHOLDER, {
    exact: true,
  });
  await expect(secretInput).toHaveValue("");
  await expect(page.getByText(SECRET_SET_HINT, { exact: true })).toBeVisible();

  // Submit with the secret left blank — the PATCH body omits jwtSecret
  // entirely (the blank-preserve contract), and the server keeps the
  // stored value.
  await page.getByRole("button", { name: "Update agent", exact: true }).click();
  await expect(heading).toHaveCount(0);

  // The saved secret still works. Reopening the edit form still says
  // "Key set ✓" — a blank save that wiped the secret would flip the
  // hint to the create-variant ("Shared HS256 secret …") — and then
  // the connection check succeeds against the mock agent (the probe
  // route, real fetch, loopback allowed by the harness env).
  await openEdit(page, name);
  await expect(page.getByText(SECRET_SET_HINT, { exact: true })).toBeVisible();
  await expect(
    page.getByPlaceholder(BLANK_SECRET_PLACEHOLDER, { exact: true }),
  ).toBeVisible();

  await agentRow(page, name)
    .getByRole("button", { name: "Test", exact: true })
    .click();
  await expect(agentRow(page, name).getByText(REACHABLE_BADGE)).toBeVisible();

  await deleteOwnAgent(page, name);
  expect(errors).toEqual([]);
  await context.close();
});

test("the form's Test connection probe reaches the mock agent", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);
  await openAgents(page);

  await page.getByRole("button", { name: "+ Add agent", exact: true }).click();
  await page.getByRole("tab", { name: "Connect an existing agent" }).click();

  // Fill the form (nothing is submitted — this test creates no agent)
  // and run the probe against the typed endpoint: the real
  // reachability-probe route, SSRF-guarded, allowed through for
  // loopback because the harness sets ALLOW_PRIVATE_ENDPOINTS=true.
  await page
    .getByPlaceholder(NAME_PLACEHOLDER, { exact: true })
    .fill(uniqueAgentName());
  await page
    .getByPlaceholder(DESCRIPTION_PLACEHOLDER, { exact: true })
    .fill(DESCRIPTION);
  await page
    .getByPlaceholder(ENDPOINT_PLACEHOLDER, { exact: true })
    .fill(MOCK_ENDPOINT);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();

  // The success badge renders next to the button (auto-dismissed after
  // 5s — asserted promptly; the probe is a loopback round-trip).
  await expect(page.getByText(REACHABLE_BADGE)).toBeVisible();

  // Close the panel — nothing was created.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Connect an existing agent" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("deleting an agent removes it — and only it — from the list", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);
  await openAgents(page);

  const name = uniqueAgentName();
  await createCustomAgent(page, { name, secret: uniqueSecret() });

  await deleteOwnAgent(page, name);

  // The delete is scoped to the created agent: the seeded agent the
  // smoke suite reads concurrently is still in the table.
  await expect(
    page.locator("table tbody tr").filter({ hasText: SEEDED_AGENT_NAME }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
