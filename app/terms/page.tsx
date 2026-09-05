import { redirect } from "next/navigation";
import { SAAS_MODE } from "@/lib/config/saas";
import { MarketingLayout } from "@/components/marketing-layout";

/**
 * Terms of Service — SaaS mode only.
 *
 * Self-host deployments redirect to `/app`: these terms describe the hosted
 * service (payments, third-party processors) and don't apply to a
 * self-hosted instance, which is governed by its operator's own terms +
 * the Elastic License 2.0.
 */
// Force request-time rendering — SAAS_MODE is a runtime env var.
export const dynamic = "force-dynamic";

export default async function TermsPage() {
  if (!SAAS_MODE) redirect("/app");

  return (
    <MarketingLayout>
      <div className="py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-zinc-500">Last updated: {new Date().getFullYear()}</p>

        <div className="mt-10 space-y-8">
          <section>
            <h2 className="text-xl font-semibold">1. Acceptance of terms</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              By creating an account or using the hosted TackUI service (the
              &quot;Service&quot;), you agree to these Terms. If you do not agree, do not
              use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">2. Your account</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              You are responsible for safeguarding your account credentials and for
              all activity under your account. You must be at least 13 years old (or
              the minimum age in your jurisdiction) to use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">3. Agent backends</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              The Service lets you connect your own agent backends that speak the
              AG-UI protocol. You are responsible for the backends you connect and
              for any data you send to them. The Service forwards your conversation
              input to the endpoint you configure — choose backends you trust with
              your data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">4. Acceptable use</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">You agree not to:</p>
            <ul className="mt-3 space-y-2 pl-6 text-zinc-600 list-disc dark:text-zinc-400">
              <li>Use the Service to process unlawful, harmful, or abusive content.</li>
              <li>Attempt to access the host&apos;s internal network or that of other users.</li>
              <li>Exceed rate limits or attempt to disrupt the Service.</li>
              <li>Resell or sublicense access without permission.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold">5. Subscriptions and billing</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              Paid plans are billed in advance on a recurring basis through our
              payment processor (Stripe). You can manage or cancel your subscription
              at any time from the account menu. Fees are non-refundable except where
              required by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">6. Service availability</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              The Service is provided on an &quot;as is&quot; basis. We do not guarantee
              uninterrupted availability and are not liable for downtime or data loss
              beyond the limits of applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">7. Termination</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              You may delete your account at any time. We may suspend or terminate
              accounts that violate these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold">8. Contact</h2>
            <p className="mt-3 leading-relaxed text-zinc-600 dark:text-zinc-400">
              Questions about these terms? Contact us at the email listed on your
              account or in the Privacy Policy.
            </p>
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
