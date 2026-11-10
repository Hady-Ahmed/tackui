import { describe, it, expect, vi, afterEach } from "vitest";

// TRUSTED_PROXY_HOPS and TRUST_CF_CONNECTING_IP are read ONCE at module
// load (the same boot-time contract as lib/config) — never per request.
// Each case therefore pins the env with vi.stubEnv and loads a FRESH
// module registry; afterEach restores both so cases can't leak into each
// other. Stubs are always concrete values ("true"/"false") so ambient
// env from other test files can't flip a case's topology.
afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function load(opts: { hops: string; cf?: string }) {
  vi.resetModules();
  vi.stubEnv("TRUSTED_PROXY_HOPS", opts.hops);
  if (opts.cf !== undefined) {
    vi.stubEnv("TRUST_CF_CONNECTING_IP", opts.cf);
  }
  return import("./client-ip");
}

function xffOnly(value: string | null) {
  return (name: string) => (name === "x-forwarded-for" ? value : null);
}

describe("getClientIp — X-Forwarded-For hop resolution", () => {
  it("SPOOF ATTEMPT: a single-entry XFF with TRUSTED_PROXY_HOPS=3 yields 'unknown', not the client-supplied leftmost entry", async () => {
    // The old clamp (Math.max(0, hops.length - TRUSTED_PROXY_HOPS))
    // selected the LEFTMOST entry on a short header — on a misconfigured
    // deployment that entry is the client's own claim, rotating a fresh
    // rate-limit bucket per request. It must collide into "unknown".
    const { getClientIp } = await load({ hops: "3", cf: "false" });
    expect(getClientIp(xffOnly("1.2.3.4"))).toBe("unknown");
  });

  it("SPOOF ATTEMPT: a two-entry XFF with TRUSTED_PROXY_HOPS=3 yields 'unknown' too", async () => {
    // Even with some padding entries, fewer entries than trusted proxies
    // means the leftmost entry can't be attributed to our own chain.
    const { getClientIp } = await load({ hops: "3", cf: "false" });
    expect(getClientIp(xffOnly("1.2.3.4,5.6.7.8"))).toBe("unknown");
  });

  it("exactly-enough hops still resolves: TRUSTED_PROXY_HOPS=3 with three entries picks the Nth-from-right", async () => {
    // Three entries, three trusted proxies → the first proxy-appended
    // entry (index 0) is the real client as seen by our outermost proxy.
    const { getClientIp } = await load({ hops: "3", cf: "false" });
    expect(getClientIp(xffOnly("203.0.113.7,10.0.0.1,10.0.0.2"))).toBe(
      "203.0.113.7",
    );
  });

  it("more hops than needed still picks the Nth-from-right (leftmost-spoof defeated)", async () => {
    // One trusted proxy, two entries: the LAST entry is what our proxy
    // appended — a prepended fake IP ("1.2.3.4") is ignored.
    const { getClientIp } = await load({ hops: "1", cf: "false" });
    expect(getClientIp(xffOnly("1.2.3.4, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("default single-hop topology keeps resolving a plain one-entry XFF (self-host case unchanged)", async () => {
    const { getClientIp } = await load({ hops: "1", cf: "false" });
    expect(getClientIp(xffOnly("198.51.100.7"))).toBe("198.51.100.7");
  });

  it("no XFF at all is still 'unknown'", async () => {
    const { getClientIp } = await load({ hops: "1", cf: "false" });
    expect(getClientIp(xffOnly(null))).toBe("unknown");
  });

  it("CF-Connecting-IP path is unaffected by the short-XFF guard (CF trusted, short XFF present)", async () => {
    // Cloudflare → Traefik deploys regularly produce a one-entry XFF
    // carrying the CF EDGE ip; with CF trust on, CF-Connecting-IP wins
    // before the XFF fallback is even consulted.
    const { getClientIp } = await load({ hops: "3", cf: "true" });
    const getHeader = (name: string) => {
      if (name === "cf-connecting-ip") return "198.51.100.9";
      if (name === "x-forwarded-for") return "10.0.0.3";
      return null;
    };
    expect(getClientIp(getHeader)).toBe("198.51.100.9");
  });

  it("an attacker-supplied CF-Connecting-IP is still ignored when CF trust is off", async () => {
    // The short-XFF guard doesn't loosen the CF rule: without the
    // topology flag the header is client-suppliable and must not mint a
    // fresh bucket — and the short XFF still fails closed to "unknown".
    const { getClientIp } = await load({ hops: "3", cf: "false" });
    const getHeader = (name: string) => {
      if (name === "cf-connecting-ip") return "198.51.100.9";
      if (name === "x-forwarded-for") return "1.2.3.4";
      return null;
    };
    expect(getClientIp(getHeader)).toBe("unknown");
  });
});

describe("TRUSTED_PROXY_HOPS floor clamp", () => {
  it("'0', negative, and junk env values all clamp to 1 — behavior equals the single-hop default, never a disabled guard", async () => {
    // Math.max(1, Number(env) || 1) is load-bearing for the fail-closed
    // path: a mis-set hop count must not widen the trust window (or
    // effectively disable the short-header guard) — it collapses to the
    // conservative single-hop default instead.
    for (const hops of ["0", "-5", "not-a-number"]) {
      const mod = await load({ hops, cf: "false" });
      expect(mod.TRUSTED_PROXY_HOPS).toBe(1);
      // Observable behavior matches the untouched default topology: a
      // plain one-entry XFF still resolves to that entry.
      expect(mod.getClientIp(xffOnly("198.51.100.7"))).toBe("198.51.100.7");
    }
  });
});

describe("degenerate XFF headers fail closed", () => {
  it("empty, comma-only, and whitespace-only XFF yield 'unknown' — not the leftmost entry, not a crash", async () => {
    // After split(', ') + trim + filter(Boolean) these headers leave
    // ZERO usable entries: nothing belongs to a trusted proxy and there
    // is no leftmost claim to trust, so resolution lands in the shared
    // "unknown" bucket rather than crashing or minting a bucket.
    const { getClientIp } = await load({ hops: "1", cf: "false" });
    for (const xff of ["", ",", " , "]) {
      expect(getClientIp(xffOnly(xff))).toBe("unknown");
    }
  });
});
