import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy:
// - scripts/styles from 'self' + 'unsafe-inline' (Next needs inline styles
//   for Tailwind/hydration; nonce-based CSP is a future improvement)
// - 'unsafe-eval' only in development (HMR/React DevTools need it)
// - connect-src 'self' + https + data (CopilotKit SSE is same-origin via
//   /api/copilotkit; https covers any future CDN fetches)
// - frame-ancestors 'none' — prevents clickjacking (nobody can iframe us)
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Legacy clickjacking defense (modern browsers use CSP frame-ancestors)
  { key: "X-Frame-Options", value: "DENY" },
  // Prevent MIME-type sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Only send origin (not full URL) to cross-origin destinations
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny access to device features the app doesn't use
  {
    key: "Permissions-Policy",
    value: "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  },
  // HSTS — production only. Tells browsers to always use HTTPS for this
  // domain for 1 year. Only safe to send when the app is behind a
  // TLS-terminating reverse proxy (documented in README). Never sent in
  // dev — would lock the browser out of http://localhost.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // Produce a self-contained .next/standalone/ directory with a minimal
  // server.js — smaller Docker image, no need to copy all of node_modules.
  // Migration SQL files are copied separately in the Dockerfile.
  output: "standalone",
  // Don't advertise the framework via X-Powered-By header
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
