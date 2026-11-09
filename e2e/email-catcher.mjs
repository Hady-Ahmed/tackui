/**
 * Local Resend-API catcher — the E2E stand-in for the mail transport.
 *
 * The app talks to Resend's HTTP API when RESEND_API_KEY is set (lib/email/
 * client.ts), and the Resend SDK reads RESEND_BASE_URL from the environment
 * — so the harness points that URL here and every email the app actually
 * sends (verification, password reset, invitation) lands in this process
 * instead of api.resend.com. The send path is the app's own real code
 * (template builders, `void sendEmail`, the callbacks in lib/auth/auth.ts);
 * only the transport's destination is local, the same way the mock agent
 * replaces the model backend — nothing in the app is stubbed.
 *
 * Contract:
 *   POST /emails        — Resend's send API shape ({ from, to, subject,
 *                         html, text }); always answered 200 {"id": "..."}
 *                         (delivery "succeeds" locally; there is no
 *                         bounce path worth modelling in the harness).
 *   GET /emails?to=...  — the emails addressed to that recipient, in
 *                         arrival order (oldest first). The e2e specs
 *                         poll this to pick up the real link an email
 *                         carries and drive it through the real UI —
 *                         the DB-driven link pattern of #107, upgraded:
 *                         the token travels exactly as a user would
 *                         receive it.
 *
 * Started by e2e/web-server.mjs (in-process) — loopback-only like the
 * mock agent, and reachable from the app container in image mode because
 * that runs --network host. Port: E2E_EMAIL_CATCHER_PORT (default 3998).
 */
import { createServer } from "node:http";

export const EMAIL_CATCHER_PORT = Number(
  process.env.E2E_EMAIL_CATCHER_PORT || 3998,
);

/** Arrival-ordered mail spool, capped so a long CI retry cannot grow it. */
const MAX_MAIL = 200;
const mail = [];

/**
 * The emails addressed to one recipient (exact, case-insensitive — the
 * `to` field is a plain address string; the app only ever passes one).
 */
export function mailFor(to) {
  return mail.filter((m) => m.to.toLowerCase() === String(to).toLowerCase());
}

/** Start the catcher; resolves with the http.Server (the caller keeps
 * a `close` in its cleanup list, like the mock agent's). */
export function startEmailCatcher(port = EMAIL_CATCHER_PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && url.pathname === "/emails") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // absurd input guard
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          mail.push({
            id: String(mail.length + 1),
            receivedAt: Date.now(),
            to: parsed.to ?? "",
            from: parsed.from ?? "",
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
            html: parsed.html ?? "",
          });
          if (mail.length > MAX_MAIL) mail.splice(0, mail.length - MAX_MAIL);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: String(mail.length) }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "invalid JSON body" }));
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/emails") {
      const to = url.searchParams.get("to");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(to === null ? mail : mailFor(to)),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `no route: ${req.method} ${url.pathname}` }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
