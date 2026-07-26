import * as Sentry from "@sentry/nextjs";

/**
 * Sentry server-side initialization (Node.js runtime).
 * No-op if SENTRY_DSN is not set (self-hosters can opt out).
 */
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",
  });
}
