/**
 * The spec-side half of the email catcher (e2e/email-catcher.mjs): the
 * "pick up the email the app really sent" helper — poll the catcher for
 * mail to one recipient and extract the link it carries.
 *
 * This is the DB-driven-link helper #107 asked for, realized at the email
 * boundary rather than the database one: better-auth 1.6 keeps nothing
 * for the email-verification journey in the `verification` table (that
 * token is a signed JWT minted at send time and handed to the app's
 * `sendVerificationEmail` callback), while the password-reset token is
 * stored as `reset-password:<token>`. Either way the app itself delivers
 * the canonical artifact — the email with the real URL — to the catcher,
 * and the spec drives exactly that link through the real UI. No app
 * stubbing; the harness only stands in for the mail transport.
 */
import { EMAIL_CATCHER_PORT } from "./email-catcher.mjs";

export interface CaughtEmail {
  id: string;
  receivedAt: number;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** The catcher's base URL — the same env contract as the app port
 * (E2E_APP_PORT): whoever launches Playwright can override the port for
 * both processes, default matches the catcher's. */
export function mailboxUrl(): string {
  return `http://127.0.0.1:${EMAIL_CATCHER_PORT}`;
}

/**
 * Wait until the catcher holds an email to `to` passing `predicate`.
 * Polling rather than assuming delivery is synchronous: better-auth
 * invokes the send callbacks with runInBackgroundOrAwait, so the signup /
 * forgot-password HTTP responses may resolve before the email has been
 * handed to the transport. Fails the test on timeout — an email that
 * never arrives is exactly the red signal the spec exists for.
 */
export async function catchEmail(
  to: string,
  predicate: (mail: CaughtEmail) => boolean,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<CaughtEmail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${mailboxUrl()}/emails?to=${encodeURIComponent(to)}`);
    if (!res.ok) {
      throw new Error(`email catcher unreadable: ${res.status} ${await res.text()}`);
    }
    const mail = (await res.json()) as CaughtEmail[];
    const match = mail.filter(predicate).at(-1);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(
        `no email to ${to} within ${timeoutMs}ms (${mail.length} other(s) in the catcher)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The first http(s) URL in the email's text part containing `marker`
 * (e.g. "/verify-email?token=" or "/reset-password/") — the plain-text
 * template embeds the raw URL on its own line (lib/email/templates.ts).
 * `id`-anchored: throw instead of returning a wrong link.
 */
export function emailLink(mail: CaughtEmail, marker: string): string {
  const link = mail.text.match(/https?:\/\/\S+/u)?.find((url) =>
    url.includes(marker),
  );
  if (!link) {
    throw new Error(
      `no ${marker} link in the ${mail.subject ?? "email"}'s text part`,
    );
  }
  return link;
}
