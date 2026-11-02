import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SSRF_GUARD_FORCE_ON } from "@/lib/config/saas";

/**
 * SSRF guard for outbound fetches to user-supplied URLs.
 *
 * Resolves the URL's hostname and rejects any address that points at a
 * private/loopback/link-local/multicast/unspecified range. This blocks
 * the common SSRF vectors:
 *   - cloud metadata endpoints (169.254.169.254)
 *   - internal services (127.0.0.1, 10.x, 192.168.x, 172.16-31.x)
 *   - IPv6 equivalents (::1, fc00::/7, fe80::/10)
 *
 * Block-by-default. Self-hosters running agent backends on the same
 * machine as the frontend can opt in with ALLOW_PRIVATE_ENDPOINTS=true.
 *
 * SaaS mode (`SAAS_MODE=true`) hard-locks the guard ON — the
 * `ALLOW_PRIVATE_ENDPOINTS` opt-in and the `allowPrivate` call option are
 * both ignored. A shared host must never let a tenant reach the host's
 * private network (cloud metadata, internal services). See
 * lib/config/saas.ts (`SSRF_GUARD_FORCE_ON`).
 *
 * Limitation: this is a pre-fetch DNS check. The check-time half of DNS
 * rebinding is closed (an unresolvable name is refused, not passed
 * through), but check-time-public → fetch-time-private rebinding is NOT
 * fully defeated — Node's fetch doesn't expose IP pinning, so a
 * re-resolve between this check and the actual connection can still
 * land inside. The pre-check blocks raw IP literals and obvious
 * internal hostnames, which covers the vast majority of real-world SSRF.
 * Run-time re-validation (see lib/agents/registry.ts) re-runs this guard
 * against the endpoint on every manual/template-agent run — builder-agent
 * runs to the operator-configured platform are deliberately exempt
 * (operator infrastructure, not a tenant URL).
 */

const ALLOW_PRIVATE =
  process.env.ALLOW_PRIVATE_ENDPOINTS === "true";

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Validates that a URL does not resolve to a private/internal IP.
 * Throws UnsafeUrlError if the URL is unsafe. Resolves otherwise.
 *
 * Set `ALLOW_PRIVATE_ENDPOINTS=true` in the environment to bypass
 * (for self-hosters running backends on localhost).
 */
export async function assertSafeUrl(
  url: string,
  opts?: { allowPrivate?: boolean },
): Promise<void> {
  // The SaaS host always runs the guard, ignoring ALLOW_PRIVATE_ENDPOINTS.
  // A single shared instance must never let a tenant reach the host's
  // private network (cloud metadata, internal services). Self-hosters keep
  // the opt-in (single-tenant — they own the network they'd reach).
  const allow = SSRF_GUARD_FORCE_ON ? false : opts?.allowPrivate ?? ALLOW_PRIVATE;
  if (allow) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }

  const hostname = parsed.hostname;
  if (!hostname) throw new UnsafeUrlError("missing hostname");

  // IPv6 literals in URLs are bracketed: http://[::1]:8000/
  // URL.hostname returns the brackets; strip them for isIP() to work.
  const hostForCheck = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // If the hostname is an IP literal, check it directly.
  const ipVersion = isIP(hostForCheck);
  if (ipVersion > 0) {
    if (isPrivateIp(hostForCheck, ipVersion as 4 | 6)) {
      throw new UnsafeUrlError("hostname resolves to a private address");
    }
    return;
  }

  // Otherwise resolve via DNS and reject if ANY resolved address is private.
  let addresses: string[];
  try {
    const result = await dnsLookup(hostname, { all: true, family: 0 });
    addresses = result.map((r) => r.address);
  } catch {
    // Fail CLOSED. The old behavior passed unresolved names through
    // ("let the downstream fetch report the error") — a rebinding window:
    // an attacker-controlled authoritative server can refuse the guard's
    // lookup and resolve public for the real fetch. A host that doesn't
    // resolve can never work anyway, so refusing here is strictly better.
    throw new UnsafeUrlError("hostname could not be resolved");
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError("hostname could not be resolved");
  }
  for (const addr of addresses) {
    const v = isIP(addr);
    if (v > 0 && isPrivateIp(addr, v as 4 | 6)) {
      throw new UnsafeUrlError("hostname resolves to a private address");
    }
  }
}

/**
 * Returns true if the IP address is in a private/reserved range.
 * Covers IPv4 and IPv6. See RFC 1918, RFC 4193, RFC 3927, RFC 4291.
 */
export function isPrivateIp(ip: string, version: 4 | 6): boolean {
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return false;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = parts;

  // 0.0.0.0/8 — unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 — private (RFC 1918)
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598); cloud providers run
  // internal services in this range.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 169.254.0.0/16 — link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 — TEST-NET-1 (documentation; not publicly routable)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.168.0.0/16 — private (RFC 1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmark testing (RFC 2544)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 — TEST-NET-2 (documentation)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 — TEST-NET-3 (documentation)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;

  return false;
}

/**
 * Expand an IPv6 address into its 8 16-bit groups (handling `::`
 * compression), or null when unparseable.
 */
function expandV6(addr: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(addr)) return null;
  // RFC 4291 form 3: the last 32 bits may be a dotted IPv4 quad
  // (::ffff:8.8.8.8) occupying the last two groups. Convert it to hex
  // groups so the generic hex parser below stays uniform.
  const dotted = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const quads = dotted[1].split(".").map((n) => parseInt(n, 10));
    if (quads.length !== 4 || quads.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hexTail = `${((quads[0] << 8) | quads[1]).toString(16)}:${((quads[2] << 8) | quads[3]).toString(16)}`;
    addr = addr.slice(0, -dotted[1].length) + hexTail;
  }
  const doubleColonCount = (addr.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;
  let head: string[];
  let tail: string[];
  let missing: number;
  if (addr.startsWith("::")) {
    tail = addr.slice(2).split(":").filter(Boolean);
    head = [];
    missing = 8 - tail.length;
  } else if (addr.endsWith("::")) {
    head = addr.slice(0, -2).split(":").filter(Boolean);
    tail = [];
    missing = 8 - head.length;
  } else if (doubleColonCount === 1) {
    const [h, t] = addr.split("::");
    head = h.split(":").filter(Boolean);
    tail = t.split(":").filter(Boolean);
    missing = 8 - head.length - tail.length;
  } else {
    head = addr.split(":");
    tail = [];
    missing = 0;
  }
  if (missing < 0) return null;
  const parse = (g: string) => parseInt(g, 16);
  const groups = [
    ...head.map(parse),
    ...Array<number>(missing).fill(0),
    ...tail.map(parse),
  ];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isPrivateV6(ip: string): boolean {
  // Normalize — strip zone id if present (e.g. fe80::1%eth0)
  const addr = ip.toLowerCase().split("%")[0];
  if (addr === "::1") return true;

  const groups = expandV6(addr);
  if (!groups) {
    // Unparseable — fail closed. An address isIP() accepted but we cannot
    // decode is an evasion encoding we don't understand; refusing it can
    // never break a legitimate endpoint.
    return true;
  }

  // :: — unspecified
  if (groups.every((g) => g === 0)) return true;

  // IPv4-mapped (…:ffff:x.y.z.w — dotted OR hex form: ::ffff:127.0.0.1 and
  // ::ffff:7f00:1 both embed 127.0.0.1) and IPv4-compatible (::a.b.c.d,
  // deprecated but still appears): the embedded 32 bits decide. The old
  // dotted-only regex missed the hex form entirely.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const hi = groups[6];
    const lo = groups[7];
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  const firstSegment = groups[0];
  const firstByte = firstSegment >> 8;

  // fc00::/7 — unique local address (RFC 4193). First 7 bits = 1111110.
  // Matches fc and fd as the first byte.
  if ((firstByte & 0xfe) === 0xfc) return true;

  // fe80::/10 — link-local. First 10 bits = 1111111010.
  if ((firstSegment & 0xffc0) === 0xfe80) return true;

  // ff00::/8 — multicast. First byte = 0xff.
  if (firstByte === 0xff) return true;

  return false;
}

/**
 * A fetch wrapper for run-time agent traffic. Redirects are followed
 * MANUALLY with two properties:
 *
 * 1. EVERY hop re-runs the SSRF guard: a public endpoint that 302s to an
 *    internal address must not turn a validated endpoint into a
 *    pass-through (the save-time check validated the first URL only, and
 *    Node's fetch follows redirects silently). Hop count is capped to
 *    bound loops; a 3xx without a Location header is returned as-is
 *    (nothing to follow).
 *
 * 2. The fetch spec's redirect semantics are applied manually — the
 *    guard's `redirect: "manual"` mode turns OFF the auto-follow that
 *    normally provides them:
 *      - 301/302/303 rewrite POST → GET and drop the body;
 *      - a CROSS-ORIGIN hop strips Authorization/Cookie/
 *        Proxy-Authorization. Without this, a compromised backend could
 *        302 a run to a third-party collector and harvest the agent JWT
 *        (headers.Authorization) plus the full conversation body — the
 *        manual loop would have re-sent `init` verbatim where plain
 *        fetch would have stripped them. Same-origin hops keep headers,
 *        matching the spec.
 *
 * Throws UnsafeUrlError when a hop fails the guard — fail-closed: the
 * run errors instead of connecting somewhere unvalidated.
 */
export async function fetchGuardedRedirects(
  url: string,
  init: RequestInit,
  maxHops = 5,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    if (hop >= maxHops) {
      throw new UnsafeUrlError("too many redirects");
    }
    const location = res.headers.get("location");
    if (!location) return res;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new UnsafeUrlError("invalid redirect location");
    }

    const status = res.status;
    const method = (init.method ?? "GET").toUpperCase();
    if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
      init = { ...init, method: "GET", body: undefined };
    }
    if (next.origin !== new URL(current).origin) {
      const headers = new Headers(init.headers);
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
      init = { ...init, headers };
    }
    current = next.toString();
  }
}
