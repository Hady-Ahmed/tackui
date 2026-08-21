import { redirect } from "next/navigation";
import { SAAS_MODE } from "@/lib/config/saas";
import { MarketingLayout } from "@/components/marketing-layout";

/**
 * Privacy Policy — SaaS mode only.
 *
 * Self-host deployments redirect to `/app`: this policy describes the hosted
 * service&apos;s data practices (processors, retention). A self-hosted instance
 * is governed by its operator&apos;s own privacy practices.
 */
// Force request-time rendering — SAAS_MODE is a runtime env var.
export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  if (!SAAS_MODE) redirect("/app");

  return (
    <MarketingLayout>
      <div className="py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-zinc-500">Last updated: {new Date().getFullYear()}</p>

        <div className="mt-10 space-y-8">
          <section>
            <h2 className="text-xl font-semibold">1. Data we collect</h2>
            <ul className="mt-3 space-y-2 pl-6 text-zinc-600 list-disc dark:text-zinc-400">
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
          </section>

          <section>
            <h2 className="text-xl font-semibold">2. How conversations are processed</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              When you send a message, the Service forwards your conversation
              history to the agent backend you configured for that conversation.
              That backend processes the data according to its own privacy policy —
              please review the policies of any backend you connect.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">3. Third-party processors</h2>
            <ul className="mt-3 space-y-2 pl-6 text-zinc-600 list-disc dark:text-zinc-400">
              <li><strong>Stripe</strong> — payment processing.</li>
              <li><strong>Resend</strong> — transactional email (verification, password reset), when enabled.</li>
              <li><strong>Better Auth</strong> — session and authentication management (self-hosted in our database).</li>
              <li><strong>Sentry</strong> — error tracking, when enabled. We capture exceptions and (optionally) performance traces, not conversation content.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold">4. Data retention</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              We retain your conversation history for as long as your account is
              active. You can delete individual conversations at any time from the
              sidebar. Deleting your account removes your data within 30 days, except
              where retention is required by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">5. Your rights</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              Depending on your jurisdiction (e.g. GDPR/CCPA), you may have the
              right to access, export, correct, or delete your personal data.
              Contact us to exercise these rights.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">6. Security</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              We use industry-standard measures: encrypted connections (TLS),
              hashed credentials, per-tenant data isolation, SSRF protection, and
              rate limiting. No method is perfectly secure, but we work to protect
              your data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">7. Cookies</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              We use essential cookies for authentication and session management.
              We do not use third-party advertising cookies. A cookie notice is
              shown on your first visit.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">8. Contact</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              Privacy questions? Contact us at the email listed in your account or
              via the support channels for your plan.
            </p>
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
