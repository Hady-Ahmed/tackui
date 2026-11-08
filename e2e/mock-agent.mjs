/**
 * Mock AG-UI agent — the E2E stand-in for a real model backend.
 *
 * A throwaway HTTP server speaking the AG-UI protocol (SSE): every POST
 * emits RUN_STARTED → a fixed assistant reply (TEXT_MESSAGE_* →
 * RUN_FINISHED). The seeded test agent's endpoint points at this server,
 * so the chat smoke test exercises tackui's real run path (CopilotKit
 * runtime, SSE plumbing, thread persistence) with zero LLM calls —
 * deterministic, fast, and free.
 *
 * The AG-UI SSE wire format is `data: <json>\n\n` per event — the same
 * bytes @ag-ui/encoder produces for JSON transport. A plain Node http
 * server writing those lines is protocol-identical for the event types
 * the client sends back (no tool calls, no state snapshots), so the
 * mock needs no dependency on @ag-ui/* at all.
 *
 * Started by e2e/web-server.mjs (in-process) — not reachable from
 * anywhere except the app on the same host, and only when the E2E env
 * runs. Port: E2E_MOCK_AGENT_PORT (default 3999).
 */
import { createServer } from "node:http";

const PORT = Number(process.env.E2E_MOCK_AGENT_PORT || 3999);

export const MOCK_AGENT_PORT = PORT;

export function startMockAgent(mockPort = PORT) {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST only" }));
      return;
    }

    // Collect the run input (AG-UI RunAgentInput) — the mock ignores it
    // except for the thread/run ids it echoes back.
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let threadId = "unknown";
      let runId = "unknown";
      try {
        const parsed = JSON.parse(body);
        threadId = parsed.threadId ?? threadId;
        runId = parsed.runId ?? runId;
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
      send({ type: "RUN_FINISHED", threadId, runId });
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(mockPort, "127.0.0.1", () => resolve(server));
  });
}
