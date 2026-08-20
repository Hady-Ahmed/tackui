import { redirect } from "next/navigation";
import Link from "next/link";
import { SAAS_MODE } from "@/lib/config/saas";

/**
 * Terms of Service — SaaS mode only.
 *
 * Self-host deployments redirect to `/app`: these terms describe the hosted
 * service (payments, third-party processors) and don't apply to a
 * self-hosted instance, which is governed by its operator's own terms +
 * the Apache-2.0 license.
 */
// Force request-time rendering — SAAS_MODE is a runtime env var.
export const dynamic = "force-dynamic";

export default function TermsPage() {
  if (!SAAS_MODE) redirect("/app");

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-zinc-500">Last updated: {new Date().getFullYear()}</p>

      <div className="prose prose-zinc mt-8 max-w-none dark:prose-invert">
        <h2>1. Acceptance of terms</h2>
        <p>
          By creating an account or using the hosted AG-UI Chat service (the
          &quot;Service&quot;), you agree to these Terms. If you do not agree, do not
          use the Service.
        </p>

        <h2>2. Your account</h2>
        <p>
          You are responsible for safeguarding your account credentials and for
          all activity under your account. You must be at least 13 years old (or
          the minimum age in your jurisdiction) to use the Service.
        </p>

        <h2>3. Agent backends</h2>
        <p>
          The Service lets you connect your own agent backends that speak the
          AG-UI protocol. You are responsible for the backends you connect and
          for any data you send to them. The Service forwards your conversation
          input to the endpoint you configure — choose backends you trust with
          your data.
        </p>

        <h2>4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service to process unlawful, harmful, or abusive content.</li>
          <li>Attempt to access the host&apos;s internal network or that of other users.</li>
          <li>Exceed rate limits or attempt to disrupt the Service.</li>
          <li>Resell or sublicense access without permission.</li>
        </ul>

        <h2>5. Subscriptions and billing</h2>
        <p>
          Paid plans are billed in advance on a recurring basis through our
          payment processor (Stripe). You can manage or cancel your subscription
          at any time from the account menu. Fees are non-refundable except where
          required by law.
        </p>

        <h2>6. Service availability</h2>
        <p>
          The Service is provided on an &quot;as is&quot; basis. We do not guarantee
          uninterrupted availability and are not liable for downtime or data loss
          beyond the limits of applicable law.
        </p>

        <h2>7. Termination</h2>
        <p>
          You may delete your account at any time. We may suspend or terminate
          accounts that violate these Terms.
        </p>

        <h2>8. Contact</h2>
        <p>
          Questions about these terms? Contact us at the email listed on your
          account or in the Privacy Policy.
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
