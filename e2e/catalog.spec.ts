/**
 * Tier 2D E2E — catalog install (#104): the monetization surface
 * (docs/catalog.md) the smoke suite could only read empty. The full
 * documented lifecycle, driven through the real UI:
 *
 * 1. Seed + install — a platform admin publishes a template through the
 *    documented admin capability (the real POST /api/catalog route — the
 *    same wire path the /admin Catalog form drives, SSRF guard included)
 *    and installs it through the real /app/catalog card ("Add to
 *    workspace"). The installed copy lands in /agents as a MANAGED row:
 *    "Catalog" chip, endpoint cell reading "Managed by catalog" (the
 *    curator's URL never leaves the server), and the fully-locked action
 *    set — no Edit, no Test, Remove only.
 * 2. Point it at the mock agent — a managed copy has no endpoint of its
 *    own (it is an entitlement, not a config copy): the runtime resolves
 *    endpoint/auth live from the template. So "pointing the installed
 *    copy" happens by editing the TEMPLATE's endpoint — the live-
 *    propagation model — and the connection check is the admin row's
 *    Test button (the real reachability probe, the same route 2B drives).
 *    The template is born pointing at a dead loopback port, so the check
 *    is driven red FIRST: green has to be earned by the edit, it is not
 *    vacuous.
 * 3. Tombstone — deleting the template does NOT delete installed copies
 *    (docs/catalog.md "Lifecycle rules"): the row stays with a "Removed"
 *    chip, still endpoint-less and locked, past chats viewable — and the
 *    workspace cleans its tombstone up via the normal Remove. The delete
 *    confirm must carry the documented blast-radius warning ("1 workspace
 *    has installed it").
 *
 * Auth budget: better-auth caps sign-in at 10/min per IP
 * (lib/auth/auth.ts), and the suite spends one login per real page flow.
 * This file runs its three tests SERIALLY in a single worker behind one
 * real login (the beforeAll hook performs the genuine login-page flow
 * once and stores the session state at module level for each test's
 * fresh context — the cookies are the ones the real login issued; each
 * test still gets its own page, so console-error watching stays
 * per-test). See docs/e2e.md "The auth budget".
 *
 * Hard rule — parallel mutation (docs/e2e.md): fullyParallel workers
 * share ONE seeded database. This file owns its template and installed
 * copy start to finish under a unique name prefix; the seeded
 * e2e-mock-agent, the seed users, and other specs' fixtures are only
 * ever read. The one real install lands in the seed admin's org — the
 * org every spec shares — but the row carries this file's unique name,
 * is deleted (asserted) before the file ends, and no other spec asserts
 * on agent-list counts. A CI retry starts from fresh random names, and
 * the beforeAll sweep deletes any leftovers from a crashed earlier
 * attempt (an ACTIVE leftover template would otherwise render a second
 * card on /app/catalog and make the install test's card-scoped locators
 * ambiguous), so a partial run can neither collide nor hang.
 */
import {
  test,
  expect,
  type APIRequestContext,
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

// One worker runs all three tests back-to-back: the single beforeAll
// login below covers them, and the lifecycle stages never interleave
// with each other.
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // The one real login-page flow for this file — the genuine
  // better-auth email/password form, not a faked cookie.
  await login(page);
  adminSession = await page.context().storageState();
  await sweepOwnLeftovers(context.request);
  await context.close();
});

/** The mock agent's URL — what the installed copy ends up running on. */
const MOCK_ENDPOINT = `http://127.0.0.1:${MOCK_AGENT_PORT}/`;

/** A loopback port the harness runs NOTHING on, chosen deliberately
 * OUTSIDE the port map (app 3990, mail catcher 3998, mock agent 3999 —
 * 3977 sits nowhere near any of them): the template is born pointing
 * here so test 2's connection check starts red and only goes green once
 * the template is pointed at the mock agent. A neighbor of a mapped
 * port would collide with whatever a developer happens to run locally —
 * the old 3991 sat one above the app's 3990 and could have flipped the
 * red-first check spuriously (CI is unaffected either way, but the port
 * keeps its distance). The SSRF guard allows it for the same reason it
 * allows the mock agent — the harness sets ALLOW_PRIVATE_ENDPOINTS=true.
 */
const DEAD_ENDPOINT = "http://127.0.0.1:3977/";

/**
 * Identity per test execution (the auth-spec lesson): a CI retry re-runs
 * this file with fresh random names, so a partial earlier attempt can
 * neither collide (slug is unique per attempt) nor be mistaken for this
 * attempt's rows. The installed copy inherits the template's name
 * (installTemplate copies it), so one prefix owns both rows.
 */
const OWN_PREFIX = "E2E Catalog Template ";
/** One random suffix shared by the name and the slug — one identity per
 * test execution, inherited end to end (the installed copy takes the
 * template's name; the slug is only the admin form's unique key). */
const SUFFIX = Math.random().toString(36).slice(2, 8);
const TEMPLATE_NAME = `${OWN_PREFIX}${SUFFIX}`;
const TEMPLATE_SLUG = `e2e-catalog-template-${SUFFIX}`;
const TAGLINE = "Installed, run-checked, and removed by e2e/catalog.spec.ts.";
const DESCRIPTION =
  "Created by the Tier 2D spec to drive the real install affordance end to end.";

/* Placeholder text of the /admin template form's endpoint field
 * (components/catalog-admin.tsx) — exact, the breakage-test lesson:
 * substring matching would let a renamed field keep satisfying the old
 * selector. (The other form fields aren't asserted on — seeding happens
 * through the API — so only the field this spec drives is pinned.) */
const ENDPOINT_PLACEHOLDER = "https://agents.example.com/flight-finder";

/** The probe's success badge (the mock agent answers GET with 405 — the
 * probe accepts any response: reachability, not protocol compliance). */
const REACHABLE_BADGE = /✓ Server reachable \(HTTP \d+\)/;
/** The probe's failure badge for the dead endpoint: connection refused
 * is not a timeout, and the route masks the raw error as "unreachable". */
const UNREACHABLE_BADGE = "✗ Cannot reach server: unreachable";

/** The desktop table row for one agent (the mobile card list is hidden
 * at the suite's viewport and never asserted on). */
function agentRow(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

/** The /admin catalog table row for one template — the UsersAdmin table
 * shares the page, but the unique template name can only match this
 * file's own row. */
function templateRow(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

/** One catalog card on /app/catalog — a direct child of the template
 * card grid (the page's only CSS grid). Scoped by the unique template
 * name: a leftover card from a crashed earlier attempt must never make
 * the card-scoped assertions ambiguous (the beforeAll sweep removes
 * leftovers anyway; this keeps the locator honest regardless). */
function catalogCard(page: Page, name: string) {
  return page.locator("div.grid > div").filter({ hasText: name });
}

/** One sweep GET, asserted: a 429 or an error-JSON body here must fail
 * naming the real cause, not surface downstream as "t.filter is not a
 * function". The body is read once — it feeds both the failure message
 * and the parse. */
async function sweepList(
  request: APIRequestContext,
  url: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await request.get(url);
  const text = await res.text();
  expect(
    res.ok(),
    `sweep GET ${url} failed: HTTP ${res.status()} — ${text.slice(0, 200)}`,
  ).toBe(true);
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error(`sweep GET ${url}: expected a JSON array of rows`);
  }
  return rows as Array<{ id: string; name: string }>;
}

/**
 * Delete everything this file created on an EARLIER attempt (best
 * effort): templates under this file's name prefix, and any installed
 * copies (which inherit the template's name). The lifecycle is this
 * file's own; the seeded e2e-mock-agent and other specs' rows carry
 * different names and are never matched. Order matters: delete the
 * template first (tombstoning its copies), then the copies — including
 * tombstones a previous attempt's template delete already left behind.
 */
async function sweepOwnLeftovers(request: APIRequestContext) {
  const templates = await sweepList(request, "/api/catalog?all=1");
  for (const template of templates.filter((t) =>
    t.name.startsWith(OWN_PREFIX),
  )) {
    await request.delete(`/api/catalog/${template.id}`);
  }
  const agents = await sweepList(request, "/api/agents");
  for (const agent of agents.filter((a) => a.name.startsWith(OWN_PREFIX))) {
    await request.delete(`/api/agents/${agent.id}`);
  }
}

/**
 * Seed the template through the documented admin capability — the real
 * POST /api/catalog route (what the /admin Catalog section itself
 * drives), auth included, SSRF guard included. Auth mode "none": the
 * mock agent needs no JWT, and secrets are not what this journey tests.
 * Resolves the template id for the install call's card mapping.
 */
async function seedTemplate(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/catalog", {
    data: {
      name: TEMPLATE_NAME,
      slug: TEMPLATE_SLUG,
      tagline: TAGLINE,
      description: DESCRIPTION,
      endpoint: DEAD_ENDPOINT,
      authMode: "none",
      isActive: true,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

test("a published template installs into the workspace through the real catalog card", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  await seedTemplate(context.request);

  // The card renders with its curated copy — the tagline the admin form
  // required is the card's one-line summary.
  await page.goto("/app/catalog");
  const card = catalogCard(page, TEMPLATE_NAME);
  await expect(
    page.getByRole("heading", { name: TEMPLATE_NAME, exact: true }),
  ).toBeVisible();
  await expect(card.getByText(TAGLINE)).toBeVisible();

  // The real install affordance: the card's one-click button — POST
  // /api/catalog/[id]/install through the UI, canManageAgents-gated
  // (the seed admin owns the workspace).
  await card
    .getByRole("button", { name: "Add to workspace", exact: true })
    .click();
  await expect(
    page.getByText(`${TEMPLATE_NAME} was added to your workspace.`),
  ).toBeVisible();
  // The card flips to the installed state (live propagation means there
  // is no user-facing update action — docs/catalog.md). Non-exact on
  // purpose: the ✓ and the label are separate spans inside one div, so
  // an exact match against the div's full text is whitespace-sensitive.
  await expect(card.getByText("Added to workspace")).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Add to workspace", exact: true }),
  ).toHaveCount(0);

  // The installed copy is a REAL agent row in /agents — an entitlement
  // pointing at the template, and fully locked: no endpoint in the API
  // ("Managed by catalog"), no Edit, no Test; only Remove is offered.
  await page.goto("/agents");
  const row = agentRow(page, TEMPLATE_NAME);
  await expect(row).toBeVisible();
  await expect(row.getByText("Catalog", { exact: true })).toBeVisible();
  await expect(
    row.getByText("Managed by catalog", { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Test", exact: true }),
  ).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Remove", exact: true }),
  ).toBeVisible();

  expect(errors).toEqual([]);
  await context.close();
});

test("the installed copy follows the template — pointing it at the mock agent passes the connection check", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // The connection check runs against the template's endpoint — what the
  // installed copy resolves live. The template was born pointing at a
  // dead loopback port, so the check is red first: the probe is not
  // vacuously green.
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", {
      name: "Catalog templates (platform admin)",
    }),
  ).toBeVisible();
  const row = templateRow(page, TEMPLATE_NAME);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.getByText(UNREACHABLE_BADGE, { exact: true })).toBeVisible();

  // Point the installed copy at the mock agent the only way a managed
  // copy moves: edit the TEMPLATE. The managed row itself takes no
  // edits (AGENT_MANAGED — the /agents row has no Edit button at all).
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const endpointField = page.getByPlaceholder(ENDPOINT_PLACEHOLDER, {
    exact: true,
  });
  await expect(endpointField).toHaveValue(DEAD_ENDPOINT);
  await endpointField.fill(MOCK_ENDPOINT);
  await page
    .getByRole("button", { name: "Update template", exact: true })
    .click();
  // The form closes on success and the row reflects the new endpoint.
  await expect(endpointField).toHaveCount(0);
  await expect(row.getByText(MOCK_ENDPOINT)).toBeVisible();

  // The connection check now passes — the real reachability probe route
  // (POST /api/agents/reachability-probe), real fetch, loopback allowed
  // by the harness env. The mock agent answers GET with 405 (it is
  // POST-only): the probe asserts reachability, not protocol compliance.
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.getByText(REACHABLE_BADGE)).toBeVisible();

  // And the managed copy still exposes none of it in /agents — the
  // endpoint edit propagates live, the curator's URL never leaves the
  // server, and the row stays locked to Remove-only.
  await page.goto("/agents");
  const managedRow = agentRow(page, TEMPLATE_NAME);
  await expect(managedRow).toBeVisible();
  await expect(
    managedRow.getByText("Managed by catalog", { exact: true }),
  ).toBeVisible();
  await expect(managedRow.getByText(MOCK_ENDPOINT)).toHaveCount(0);
  await expect(
    managedRow.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await expect(
    managedRow.getByRole("button", { name: "Test", exact: true }),
  ).toHaveCount(0);

  expect(errors).toEqual([]);
  await context.close();
});

test("deleting the template tombstones the installed copy — the workspace removes it from there", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  const errors = watchConsoleErrors(page);

  // Delete the template through the admin table. The confirm must name
  // its victim AND carry the documented blast-radius warning — one
  // workspace (this file's install) has it installed, and the copy
  // will be removed from that workspace while past chats stay viewable.
  // The dialog is awaited as an EVENT (waitForEvent), not asserted from
  // a once-listener's side effect: `await click()` resolves when the
  // input was dispatched, before the renderer's confirm() has necessarily
  // emitted the dialog event, so a same-tick assert races the dialog
  // (observed under full-suite load — dialogMessage read null).
  await page.goto("/admin");
  const row = templateRow(page, TEMPLATE_NAME);
  await expect(row).toBeVisible();
  const templateDialog = page
    .waitForEvent("dialog", { timeout: 10_000 })
    .then((dialog: Dialog) => {
      const message = dialog.message();
      void dialog.accept();
      return message;
    });
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  expect(await templateDialog).toBe(
    `Delete catalog template "${TEMPLATE_NAME}"? 1 workspace has installed it — their installed copies will be removed from those workspaces (past chats stay viewable).`,
  );
  // The template is gone from the admin table.
  await expect(row).toHaveCount(0);

  // Tombstone (docs/catalog.md "Lifecycle rules"): the installed copy
  // STAYS — the rows survive so past conversations remain viewable —
  // with the "Removed" chip, still endpoint-less, still locked to
  // Remove-only (an endpoint-less, non-runnable agent).
  await page.goto("/agents");
  const tombstone = agentRow(page, TEMPLATE_NAME);
  await expect(tombstone).toBeVisible();
  await expect(
    tombstone.getByText("Removed", { exact: true }),
  ).toBeVisible();
  await expect(
    tombstone.getByText("Managed by catalog", { exact: true }),
  ).toBeVisible();
  await expect(
    tombstone.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await expect(
    tombstone.getByRole("button", { name: "Test", exact: true }),
  ).toHaveCount(0);

  // The org cleans its tombstone up via the normal Remove (its own
  // agent DELETE) — the dialog names the victim (awaited as an event,
  // same race-free shape as above), and only this row goes: the seeded
  // agent the smoke suite reads is untouched.
  const removeDialog = page
    .waitForEvent("dialog", { timeout: 10_000 })
    .then((dialog: Dialog) => {
      const message = dialog.message();
      void dialog.accept();
      return message;
    });
  await tombstone.getByRole("button", { name: "Remove", exact: true }).click();
  expect(await removeDialog).toBe(
    `Delete agent "${TEMPLATE_NAME}"? This cannot be undone.`,
  );
  await expect(tombstone).toHaveCount(0);
  await expect(
    page.locator("table tbody tr").filter({ hasText: "E2E Mock Agent" }),
  ).toBeVisible();

  expect(errors).toEqual([]);
  await context.close();
});
