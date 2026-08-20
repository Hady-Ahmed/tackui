import { redirect } from "next/navigation";
import Link from "next/link";
import { SAAS_MODE } from "@/lib/config/saas";

/**
 * Privacy Policy — SaaS mode only.
 *
 * Self-host deployments redirect to `/app`: this policy describes the hosted
 * service&apos;s data practices (processors, retention). A self-hosted instance
 * is governed by its operator&apos;s own privacy practices.
 */
// Force request-time rendering — SAAS_MODE is a runtime env var.
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  if (!SAAS_MODE) redirect("/app");

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-zinc-500">Last updated: {new Date().getFullYear()}</p>

      <div className="prose prose-zinc mt-8 max-w-none dark:prose-invert">
        <h2>1. Data we collect</h2>
        <ul>
          <li>
            <strong>Account data:</strong> email, name, and authentication
            credentials managed by our auth provider.
          </li>
          <li>
            <strong>Conversation data:</strong> messages you exchange with
            agents are stored in our database so you can resume conversations.
          </li>
          <li>
            <strong>Agent configuration:</strong> the endpoint URLs and names of
            the agent backends you connect.
          </li>
          <li>
            <strong>Billing data:</strong> payment is handled by Stripe; we do
            not store full card numbers.
          </li>
        </ul>

        <h2>2. How conversations are processed</h2>
        <p>
          When you send a message, the Service forwards your conversation
          history to the agent backend you configured for that conversation.
          That backend processes the data according to its own privacy policy —
          please review the policies of any backend you connect.
        </p>

        <h2>3. Third-party processors</h2>
        <ul>
          <li><strong>Stripe</strong> — payment processing.</li>
          <li><strong>Resend</strong> — transactional email (verification, password reset), when enabled.</li>
          <li><strong>Better Auth</strong> — session and authentication management (self-hosted in our database).</li>
          <li><strong>Sentry</strong> — error tracking, when enabled. We capture exceptions and (optionally) performance traces, not conversation content.</li>
        </ul>

        <h2>4. Data retention</h2>
        <p>
          We retain your conversation history for as long as your account is
          active. You can delete individual conversations at any time from the
          sidebar. Deleting your account removes your data within 30 days, except
          where retention is required by law.
        </p>

        <h2>5. Your rights</h2>
        <p>
          Depending on your jurisdiction (e.g. GDPR/CCPA), you may have the
          right to access, export, correct, or delete your personal data.
          Contact us to exercise these rights.
        </p>

        <h2>6. Security</h2>
        <p>
          We use industry-standard measures: encrypted connections (TLS),
          hashed credentials, per-tenant data isolation, SSRF protection, and
          rate limiting. No method is perfectly secure, but we work to protect
          your data.
        </p>

        <h2>7. Cookies</h2>
        <p>
          We use essential cookies for authentication and session management.
          We do not use third-party advertising cookies. A cookie notice is
          shown on your first visit.
        </p>

        <h2>8. Contact</h2>
        <p>
          Privacy questions? Contact us at the email listed in your account or
          via the support channels for your plan.
        </p>
      </div>

      <div className="mt-12">
        <Link href="/" className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          ← Back to home
        </Link>
      </div>
    </div>
  );
}
