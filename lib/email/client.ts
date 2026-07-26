import { Resend } from "resend";

/**
 * Resend email client singleton.
 *
 * When RESEND_API_KEY is not set, email features are disabled entirely
 * (email verification, password reset). The app works without email —
 * self-hosters can opt in by setting RESEND_API_KEY + EMAIL_FROM.
 *
 * Set EMAIL_FROM to a verified sender address (e.g. noreply@yourdomain.com).
 * Resend requires domain verification for custom domains — see
 * https://resend.com/domains for setup.
 */
export const EMAIL_ENABLED = !!process.env.RESEND_API_KEY;
export const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@localhost";

export const resend: Resend | null = EMAIL_ENABLED
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Send an email via Resend. Silently logs errors (does not throw) —
 * email delivery failures should not break the auth flow. The caller
 * (Better Auth callback) uses `void sendEmail(...)` to avoid awaiting.
 *
 * When email is disabled, this is a no-op.
 */
export async function sendEmail(
  to: string,
  content: EmailContent,
): Promise<void> {
  if (!resend) return;
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  } catch (err) {
    console.error("[email] failed to send", {
      to,
      subject: content.subject,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
