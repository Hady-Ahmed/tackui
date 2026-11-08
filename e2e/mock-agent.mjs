/**
 * Mock AG-UI agent — the E2E stand-in for a real model backend.
 *
 * A throwaway HTTP server speaking the AG-UI protocol (SSE): every POST
 * emits RUN_STARTED → a fixed assistant reply (TEXT_MESSAGE_* →
 * RUN_FINISHED). The seeded test agent's endpoint points at this server,
 * so the chat tests exercise tackui's real run path (CopilotKit
 * runtime, SSE plumbing, thread persistence) with zero LLM calls —
 * deterministic, fast, and free.
 *
 * Tool calls (Tier 2A, #101): when the incoming message contains
 * TOOL_TRIGGER ("use the tool"), the same reply additionally carries the
 * AG-UI tool-call events (TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT,
 * per https://docs.ag-ui.com/concepts/events) so the chat spec can assert
 * the tool render block. The plain-reply path stays byte-identical —
 * Tier 1's chat test is the regression guard on that.
 *
 * The AG-UI SSE wire format is `data: <json>\n\n` per event — the same
 * bytes @ag-ui/encoder produces for JSON transport. A plain Node http
 * server writing those lines is protocol-identical for the event types
 * the client sends back (no state snapshots), so the mock needs no
 * dependency on @ag-ui/* at all.
 *
 * Started by e2e/web-server.mjs (in-process) — not reachable from
 * anywhere except the app on the same host, and only when the E2E env
 * runs. Port: E2E_MOCK_AGENT_PORT (default 3999).
 */
import { createServer } from "node:http";

const PORT = Number(process.env.E2E_MOCK_AGENT_PORT || 3999);

/**
 * The trigger phrase (kept in sync with e2e/chat.spec.ts): a user message
 * containing it makes the run carry tool-call events. Matched on the LAST
 * user message of the run input — the message this run answers.
 */
export const TOOL_TRIGGER = "use the tool";

/** The mock's fixed tool name — humanized ("Echo tool") by the tool render. */
export const TOOL_NAME = "echo_tool";

/**
 * The last user message's text content, best-effort. Content is a string
 * for plain text messages; array-of-parts (text parts) is tolerated the
 * same way the AG-UI message schema allows.
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
    return "";
  }
  return "";
}

export const MOCK_AGENT_PORT = PORT;

export function startMockAgent(mockPort = PORT) {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST only" }));
      return;
    }

    // Collect the run input (AG-UI RunAgentInput) — the mock ignores it
    // except for the thread/run ids it echoes back and the trigger-phrase
    // check on the last user message.
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let threadId = "unknown";
      let runId = "unknown";
      // Set when the last user message contains TOOL_TRIGGER — the run
      // then carries tool-call events after the (unchanged) text reply.
      let toolQuery = null;
      try {
        const parsed = JSON.parse(body);
        threadId = parsed.threadId ?? threadId;
        runId = parsed.runId ?? runId;
        const text = lastUserText(parsed.messages);
        if (text.includes(TOOL_TRIGGER)) toolQuery = text;
      } catch {
        // Malformed input — still emit a valid run so the UI shows the
        // failure mode (the client's event verification flags it).
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const messageId = `msg-${Math.random().toString(36).slice(2, 10)}`;
      send({ type: "RUN_STARTED", threadId, runId });
      send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "E2E mock agent reply" });
      send({ type: "TEXT_MESSAGE_END", messageId });
      if (toolQuery !== null) {
        // AG-UI tool-call sequence (all ids verifier-legal: START opens,
        // ARGS appends, END closes, RESULT lands after END). The tool call
        // attaches to the assistant message via parentMessageId so it
        // renders inside that bubble; the result rides its own tool
        // message (role "tool") keyed by toolCallId. The args echo the
        // triggering message so the spec can assert the round-trip.
        const toolCallId = `tc-${Math.random().toString(36).slice(2, 10)}`;
        send({
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: TOOL_NAME,
          parentMessageId: messageId,
        });
        send({
          type: "TOOL_CALL_ARGS",
          toolCallId,
          delta: JSON.stringify({ query: toolQuery }),
        });
        send({ type: "TOOL_CALL_END", toolCallId });
        send({
          type: "TOOL_CALL_RESULT",
          messageId: `${toolCallId}-result`,
          toolCallId,
          role: "tool",
          // Heading + bold → the tool render's markdown path (react-markdown).
          content: "## Echo result\n\n**echo_tool** completed successfully.",
        });
      }
      send({ type: "RUN_FINISHED", threadId, runId });
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(mockPort, "127.0.0.1", () => resolve(server));
  });
}
