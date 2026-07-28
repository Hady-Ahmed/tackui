import * as Sentry from "@sentry/nextjs";

/**
 * Sentry client-side initialization.
 *
 * Next.js 16 uses Turbopack by default. Under Turbopack, `withSentryConfig`
 * no longer auto-injects `sentry.client.config.ts` into the client bundle
 * (that injection is webpack-only). The supported replacement is the
 * `instrumentation-client.ts` file convention, which Next.js loads in the
 * browser automatically — see
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
 *
 * No-op if NEXT_PUBLIC_SENTRY_DSN is not set (self-hosters can opt out).
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",
  });
}

// Required by @sentry/nextjs under Turbopack to instrument client-side
// route transitions. Without this export the SDK logs an action-required
// warning at build time.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
