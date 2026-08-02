import type { EmailContent } from "./client";

/**
 * Email template builders. Each returns { subject, html, text }.
 * The HTML and text versions contain the same essential information —
 * HTML for rendering, text for spam-filter friendliness and accessibility.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function verificationEmail(
  user: { name?: string | null; email: string },
  url: string,
): EmailContent {
  const name = user.name || user.email;
  const subject = "Verify your email address";
  const text = `Hi ${name},\n\nPlease verify your email address by clicking the link below:\n${url}\n\nThis link will expire in 24 hours. If you didn't create an account, you can ignore this email.\n\n— AG-UI Chat`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #111827; margin-bottom: 16px;">Verify your email address</h2>
      <p style="color: #4B5563; line-height: 1.5;">Hi ${escapeHtml(name)},</p>
      <p style="color: #4B5563; line-height: 1.5;">
        Please verify your email address by clicking the button below:
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(url)}"
           style="display: inline-block; background: #2563EB; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
          Verify email
        </a>
      </p>
      <p style="color: #6B7280; font-size: 13px; line-height: 1.5;">
        Or copy this link: ${escapeHtml(url)}
      </p>
      <p style="color: #6B7280; font-size: 13px; line-height: 1.5; margin-top: 24px;">
        This link will expire in 24 hours. If you didn't create an account, you can ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
      <p style="color: #9CA3AF; font-size: 12px;">AG-UI Chat</p>
    </div>
  `;
  return { subject, html, text };
}

export function passwordResetEmail(
  user: { name?: string | null; email: string },
  url: string,
): EmailContent {
  const name = user.name || user.email;
  const subject = "Reset your password";
  const text = `Hi ${name},\n\nWe received a request to reset your password. Click the link below to set a new password:\n${url}\n\nThis link will expire in 1 hour. If you didn't request a password reset, you can ignore this email.\n\n— AG-UI Chat`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #111827; margin-bottom: 16px;">Reset your password</h2>
      <p style="color: #4B5563; line-height: 1.5;">Hi ${escapeHtml(name)},</p>
      <p style="color: #4B5563; line-height: 1.5;">
        We received a request to reset your password. Click the button below to set a new one:
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(url)}"
           style="display: inline-block; background: #2563EB; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
          Reset password
        </a>
      </p>
      <p style="color: #6B7280; font-size: 13px; line-height: 1.5;">
        Or copy this link: ${escapeHtml(url)}
      </p>
      <p style="color: #6B7280; font-size: 13px; line-height: 1.5; margin-top: 24px;">
        This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
      <p style="color: #9CA3AF; font-size: 12px;">AG-UI Chat</p>
    </div>
  `;
  return { subject, html, text };
}

export function invitationEmail(
  data: {
    email: string;
    organizationName: string;
    inviterName: string;
    acceptUrl: string;
  },
): EmailContent {
  const subject = `${data.inviterName} invited you to join "${data.organizationName}"`;
  const text = `Hi,\n\n${data.inviterName} has invited you to join the "${data.organizationName}" workspace on AG-UI Chat.\n\nClick the link below to accept the invitation:\n${data.acceptUrl}\n\nIf you weren't expecting this invitation, you can ignore this email.\n\n— AG-UI Chat`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #111827; margin-bottom: 16px;">You're invited to join ${escapeHtml(data.organizationName)}</h2>
      <p style="color: #4B5563; line-height: 1.5;">
        ${escapeHtml(data.inviterName)} has invited you to collaborate in the
        <strong>${escapeHtml(data.organizationName)}</strong> workspace on AG-UI Chat.
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(data.acceptUrl)}"
           style="display: inline-block; background: #2563EB; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
          Accept invitation
        </a>
      </p>
      <p style="color: #6B7280; font-size: 13px; line-height: 1.5;">
        Or copy this link: ${escapeHtml(data.acceptUrl)}
      </p>
      <p style="color: #6B7280; font-size: 13px; line-height: 1.5; margin-top: 24px;">
        If you weren't expecting this invitation, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
      <p style="color: #9CA3AF; font-size: 12px;">AG-UI Chat</p>
    </div>
  `;
  return { subject, html, text };
}
