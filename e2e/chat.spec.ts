/**
 * Tier 2A E2E — chat depth (#101): the three high-value chat behaviors
 * Tier 1's single plain-text round-trip can't cover. Same harness and
 * conventions as smoke.spec.ts (docs/e2e.md): real built app, throwaway
 * Postgres, real better-auth sessions, mock AG-UI agent — only the model
 * is faked.
 *
 * 1. Thread persistence across reload — send → reply → full reload →
 *    reopen the conversation from the sidebar: user message and reply
 *    still render. Exercises the conversation-history contract (threads
 *    API + PostgresAgentRunner + /connect replay) through the real cookie
 *    gate. Thread ids are NOT client-persisted (a reload starts a fresh
 *    one), so the reload alone shows an empty chat — the reopen-from-
 *    sidebar step IS the persistence assertion.
 * 2. Tool-call rendering — a message containing the mock agent's trigger
 *    phrase ("use the tool", e2e/mock-agent.mjs) makes the run carry
 *    AG-UI tool-call events; the tool render block (components/tools/
 *    tool-renders.tsx, the react-markdown path) renders inside the
 *    assistant bubble.
 * 3. Multi-turn ordering — two send/reply cycles stay ordered in one
 *    thread.
 *
 * The smoke suite stays frozen at its 8 tests; deeper journeys grow here
 * (and in later Tier 2 files), never into smoke.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { TOOL_TRIGGER } from "./mock-agent.mjs";
import { login, watchConsoleErrors } from "./helpers";

/** The mock agent's fixed reply text (e2e/mock-agent.mjs). */
const MOCK_REPLY = "E2E mock agent reply";

/** Send a message through the real chat input. */
async function send(page: Page, text: string) {
  const input = page.getByPlaceholder("Type a message...", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

/**
 * The run is fully settled: the sidebar conversation (titled with the
 * first user message — the runner's deriveTitle) appears when the client
 * refetches threads on run finalization, which is strictly after the
 * server persisted the run. A settle signal before any follow-up action:
 * a second send racing the per-thread run lock would 409 ("Thread
 * already running").
 */
async function expectRunSettled(page: Page, firstUserMessage: string) {
  // The desktop sidebar is the first <aside> in the DOM; the mobile
  // drawer duplicates the list hidden behind md:hidden (the same
  // first()-narrowing the smoke suite uses for agent rows).
  const sidebar = page.locator("aside").first();
  await expect(
    sidebar.getByText(firstUserMessage, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("chat — thread persistence", () => {
  test("a conversation survives a reload and reopens from the sidebar", async ({
    page,
  }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.getByText("E2E Mock Agent").first().click();

    // ≤50 chars so the sidebar title is this exact text (deriveTitle
    // truncates at 50).
    const probe = "Reload persistence probe";
    await send(page, probe);
    await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 30_000 });
    await expectRunSettled(page, probe);

    // Full reload — a real page load through the cookie gate (proxy.ts).
    await page.reload();
    await expect(
      page.getByPlaceholder("Type a message...", { exact: true }),
    ).toBeVisible();

    // Reopen the persisted thread: the threads API lists it (title = the
    // first user message), the click remounts CopilotChat on that
    // threadId, and the /connect replay rebuilds the turn from
    // PostgresAgentRunner's persisted history.
    await page.getByText(probe, { exact: true }).first().click();

    await expect(
      page
        .getByTestId("copilot-user-message")
        .getByText(probe, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("copilot-assistant-message").getByText(MOCK_REPLY),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("chat — tool-call rendering", () => {
  test("a tool call renders inside the assistant bubble", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.getByText("E2E Mock Agent").first().click();

    // The mock agent's tool path: this phrase makes the run carry
    // TOOL_CALL_* events after the (unchanged) text reply.
    const probe = `${TOOL_TRIGGER} to echo this`;
    await send(page, probe);

    const bubble = page.getByTestId("copilot-assistant-message");
    await expect(bubble).toBeVisible({ timeout: 30_000 });
    // The wildcard tool render (components/tools/tool-renders.tsx) shows
    // the humanized name — the CopilotKit default fallback would render
    // the raw tool name instead, so this asserts OUR renderer ran.
    const toolRow = bubble.getByText("Echo tool", { exact: true });
    await expect(toolRow).toBeVisible();

    // Expand: args as key-value rows + the result through the
    // react-markdown path — no other tier renders either.
    await toolRow.click();
    await expect(bubble.getByText("Arguments", { exact: true })).toBeVisible();
    await expect(bubble.getByText("query", { exact: true })).toBeVisible();
    // The args echo the triggering message (the collapsed preview and the
    // expanded row both show it — first() narrows to the collapsed row).
    await expect(bubble.getByText(probe, { exact: true }).first()).toBeVisible();
    await expect(bubble.getByText("Result", { exact: true })).toBeVisible();
    await expect(
      bubble.getByRole("heading", { name: "Echo result" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("chat — multi-turn", () => {
  test("two exchanges stay ordered in one thread", async ({ page }) => {
    const errors = watchConsoleErrors(page);
    await login(page);
    await page.getByText("E2E Mock Agent").first().click();

    const first = "Multi-turn first exchange";
    const second = "Multi-turn second exchange";
    await send(page, first);
    await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 30_000 });
    // Settled = persisted + finalized — the second send must not race the
    // per-thread run lock.
    await expectRunSettled(page, first);

    await send(page, second);
    await expect(page.getByText(MOCK_REPLY)).toHaveCount(2, { timeout: 30_000 });

    // DOM order is conversation order: user1, reply1, user2, reply2 —
    // both user messages and both replies, in one thread.
    const bubbles = page.locator(
      '[data-testid="copilot-user-message"], [data-testid="copilot-assistant-message"]',
    );
    await expect(bubbles).toHaveCount(4);
    const rendered = await bubbles.evaluateAll((elements) =>
      elements.map((el) => el.textContent?.trim() ?? ""),
    );
    expect(rendered).toEqual([
      first,
      MOCK_REPLY,
      second,
      MOCK_REPLY,
    ]);
    expect(errors).toEqual([]);
  });
});
