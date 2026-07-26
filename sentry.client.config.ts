import * as Sentry from "@sentry/nextjs";

/**
 * Sentry client-side initialization.
 * No-op if SENTRY_DSN is not set (self-hosters can opt out).
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: process.env.NODE_ENV,
    // Don't send errors in dev — they're noisy and not actionable.
    enabled: process.env.NODE_ENV === "production",
  });
}
