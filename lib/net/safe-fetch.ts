import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

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
 * Limitation: this is a pre-fetch DNS check. DNS rebinding (a domain
 * that resolves to a public IP at check time, then to an internal IP at
 * fetch time) is not fully defeated — Node's fetch doesn't expose IP
 * pinning. The pre-check blocks raw IP literals and obvious internal
 * hostnames, which covers the vast majority of real-world SSRF.
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
  const allow = opts?.allowPrivate ?? ALLOW_PRIVATE;
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
    // DNS failure — let the downstream fetch report the error.
    return;
  }

  if (addresses.length === 0) return;
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
  const [a, b] = parts;

  // 0.0.0.0/8 — unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 — private (RFC 1918)
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private (RFC 1918)
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;

  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Normalize — strip zone id if present (e.g. fe80::1%eth0)
  const addr = lower.split("%")[0];

  // ::1 — loopback
  if (addr === "::1") return true;
  // :: — unspecified
  if (addr === "::") return true;

  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4
  const v4MappedMatch = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isPrivateV4(v4MappedMatch[1]);
  }

  // IPv4-compatible (::a.b.c.d, deprecated but still appears)
  const v4CompatMatch = addr.match(/::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4CompatMatch) {
    return isPrivateV4(v4CompatMatch[1]);
  }

  // Parse the first 16-bit segment (before any `::` compression).
  const firstSegStr = addr.split(":")[0];
  const firstSegment = parseInt(firstSegStr, 16);
  if (Number.isNaN(firstSegment)) return false;

  // The first byte of the address is the high byte of the first segment.
  const firstByte = firstSegment >> 8;

  // fc00::/7 — unique local address (RFC 4193). First 7 bits = 1111110.
  // Matches fc and fd as the first byte.
  if ((firstByte & 0xfe) === 0xfc) return true;

  // fe80::/10 — link-local. First 10 bits = 1111111010.
  // firstSegment & 0xffc0 extracts the top 10 bits; must equal 0xfe80.
  if ((firstSegment & 0xffc0) === 0xfe80) return true;

  // ff00::/8 — multicast. First byte = 0xff.
  if (firstByte === 0xff) return true;

  return false;
}
