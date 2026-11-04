/**
 * Client-IP resolution shared by the proxy's per-IP flood limiter and any
 * route that rate-limits by IP directly (e.g. the deep health probe,
 * which the proxy deliberately leaves unlimited).
 *
 * Resolution order:
 * 1. `CF-Connecting-IP` — set by Cloudflare to the real client IP. When
 *    the app is behind Cloudflare → Traefik (Coolify), Traefik overwrites
 *    `X-Forwarded-For` with the Cloudflare edge IP (not the client), but
 *    it passes `CF-Connecting-IP` through untouched. This is the reliable
 *    source for the real client IP behind a Cloudflare-proxied deploy.
 * 2. `X-Forwarded-For` with TRUSTED_PROXY_HOPS — for self-hosters not
 *    behind Cloudflare. Reads the Nth-from-right entry where N is the
 *    hop count (default 1). Defeats leftmost-spoofing: a client can
 *    prepend fake IPs, but the trusted proxy appends the real IP last.
 * 3. `"unknown"` — no headers present (direct connection in dev, or a
 *    proxy that strips both headers).
 *
 * Security note on CF-Connecting-IP: if someone bypasses Cloudflare and
 * hits the origin directly, they could send a fake `CF-Connecting-IP`.
 * This is mitigated by the app container only listening on its internal
 * port (external traffic must go through Cloudflare → Traefik), and even
 * if spoofed, per-user rate limits in route handlers still apply.
 */

/** Number of trusted reverse-proxy hops in front of this server (see above). */
export const TRUSTED_PROXY_HOPS = Math.max(
  1,
  Number(process.env.TRUSTED_PROXY_HOPS ?? "1") || 1,
);

/**
 * Whether `CF-Connecting-IP` may be trusted as the client-IP source.
 *
 * The header is client-suppliable on any deployment WITHOUT Cloudflare in
 * front: an attacker hitting the origin directly can rotate it per request
 * and get a fresh bucket in every IP-keyed limiter (global flood cap, the
 * deep health probe, Better Auth's sign-in limiter — unbounded credential
 * stuffing). So it is honored only when the topology is known to include
 * Cloudflare: SAAS_MODE (the operator's documented CF → Traefik topology)
 * or an explicit TRUST_CF_CONNECTING_IP=true opt-in for non-SaaS CF
 * deploys. Everywhere else the resolver falls through to X-Forwarded-For
 * with TRUSTED_PROXY_HOPS, which a trusted proxy always appends the real
 * IP to. Mirror the same order in Better Auth's `ipAddressHeaders`
 * (lib/auth/auth.ts) — a mismatch would reintroduce the bypass there.
 */
export const TRUST_CF_CONNECTING_IP = process.env.TRUST_CF_CONNECTING_IP
  ? process.env.TRUST_CF_CONNECTING_IP === "true"
  : process.env.SAAS_MODE === "true";

/**
 * Extract the client IP from a request's forwarding headers. Accepts the
 * minimal header surface (`get(name)`) so both NextRequest and plain
 * `Request` objects work.
 */
export function getClientIp(getHeader: (name: string) => string | null): string {
  // Cloudflare sets this to the real client IP — check it first, but only
  // when the topology is known to include Cloudflare (see the flag's doc):
  // on a non-CF deployment the header is client-suppliable and rotating it
  // would reset every IP-keyed limiter bucket.
  if (TRUST_CF_CONNECTING_IP) {
    const cfIp = getHeader("cf-connecting-ip");
    if (cfIp) return cfIp.trim();
  }

  // Fallback: X-Forwarded-For with trusted-proxy-hop counting.
  const xff = getHeader("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      // Take the Nth-from-right. If we have fewer hops than trusted
      // proxies (direct connection, or proxy didn't forward), fall
      // back to the leftmost available entry.
      const idx = Math.max(0, hops.length - TRUSTED_PROXY_HOPS);
      return hops[idx] ?? hops[0] ?? "unknown";
    }
  }
  return "unknown";
}
