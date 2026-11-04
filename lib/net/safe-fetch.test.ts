import { describe, it, expect, vi, afterEach } from "vitest";
import { assertSafeUrl, fetchGuardedRedirects, UnsafeUrlError, isPrivateIp } from "./safe-fetch";

// The ALLOW_PRIVATE env var is read at module load time. These tests
// run with the default (false) unless overridden via the `allowPrivate`
// option on assertSafeUrl. We test the env bypass separately below.

describe("isPrivateIp", () => {
  describe("IPv4", () => {
    it.each([
      ["127.0.0.1", true, "loopback"],
      ["127.255.255.255", true, "loopback range"],
      ["10.0.0.1", true, "private 10.x"],
      ["192.168.1.1", true, "private 192.168.x"],
      ["172.16.0.1", true, "private 172.16 start"],
      ["172.31.255.255", true, "private 172.31 end"],
      ["169.254.169.254", true, "link-local (cloud metadata)"],
      ["0.0.0.0", true, "unspecified"],
      ["224.0.0.1", true, "multicast"],
      ["240.0.0.1", true, "reserved"],
    ])("%s → %s (%s)", (ip, expected) => {
      expect(isPrivateIp(ip, 4)).toBe(expected);
    });

    it.each([
      ["100.64.1.1", true, "CGNAT (RFC 6598) — cloud internal services"],
      ["100.127.255.255", true, "CGNAT top edge"],
      ["192.0.0.1", true, "IETF protocol assignments"],
      ["198.18.0.1", true, "benchmark testing start"],
      ["198.19.255.255", true, "benchmark testing end"],
      ["192.0.2.1", true, "TEST-NET-1"],
      ["198.51.100.7", true, "TEST-NET-2"],
      ["203.0.113.9", true, "TEST-NET-3"],
    ])("%s → %s (%s)", (ip, expected) => {
      expect(isPrivateIp(ip, 4)).toBe(expected);
    });

    it.each([
      ["1.1.1.1", false, "public DNS"],
      ["8.8.8.8", false, "Google DNS"],
      ["172.15.255.255", false, "just below private range"],
      ["172.32.0.0", false, "just above private range"],
      ["11.0.0.1", false, "public 11.x"],
      ["193.0.0.1", false, "public"],
      ["100.63.255.255", false, "just below CGNAT"],
      ["100.128.0.0", false, "just above CGNAT"],
      ["198.20.0.1", false, "just above benchmark range"],
    ])("%s → %s (%s)", (ip, expected) => {
      expect(isPrivateIp(ip, 4)).toBe(expected);
    });
  });

  describe("IPv6", () => {
    it.each([
      ["::1", true, "loopback"],
      ["::", true, "unspecified"],
      ["fc00::1", true, "unique local fc00"],
      ["fd00::1", true, "unique local fd00"],
      ["fe80::1", true, "link-local"],
      ["ff02::1", true, "multicast"],
    ])("%s → %s (%s)", (ip, expected) => {
      expect(isPrivateIp(ip, 6)).toBe(expected);
    });

    it.each([
      ["2606:4700:4700::1111", false, "Cloudflare DNS"],
      ["2001:4860:4860::8888", false, "Google DNS"],
    ])("%s → %s (%s)", (ip, expected) => {
      expect(isPrivateIp(ip, 6)).toBe(expected);
    });

    it("detects IPv4-mapped IPv6 addresses", () => {
      expect(isPrivateIp("::ffff:127.0.0.1", 6)).toBe(true);
      expect(isPrivateIp("::ffff:169.254.169.254", 6)).toBe(true);
      expect(isPrivateIp("::ffff:8.8.8.8", 6)).toBe(false);
      // Hex form of the embedded address — the old dotted-only regex
      // missed this encoding entirely (0x7f00:0001 == 127.0.0.1).
      expect(isPrivateIp("::ffff:7f00:1", 6)).toBe(true);
      expect(isPrivateIp("::ffff:a809:201", 6)).toBe(false); // 168.9.2.1 public
      expect(isPrivateIp("::ffff:a9fe:a9fe", 6)).toBe(true); // 169.254.169.254
      // Full 8-group form (no :: compression).
      expect(isPrivateIp("0:0:0:0:0:ffff:7f00:1", 6)).toBe(true);
      // Deprecated v4-compatible form (::127.0.0.1 == all-zero 80-bit prefix).
      expect(isPrivateIp("::7f00:1", 6)).toBe(true);
      expect(isPrivateIp("::808:808", 6)).toBe(false); // 8.8.8.8 public
    });

    it("fails closed on unparseable IPv6 literals", () => {
      // An address isIP() accepted but we can't decode is treated as
      // private — an unknown encoding must never pass.
      expect(isPrivateIp("::zzzz", 6)).toBe(true);
    });

    it("strips zone ids", () => {
      expect(isPrivateIp("fe80::1%eth0", 6)).toBe(true);
    });
  });
});

describe("assertSafeUrl", () => {
  describe("with IP-literal hostnames (no DNS needed)", () => {
    it("rejects 127.0.0.1", async () => {
      await expect(assertSafeUrl("http://127.0.0.1:8000/agent")).rejects.toThrow(
        UnsafeUrlError,
      );
    });

    it("rejects 169.254.169.254 (cloud metadata)", async () => {
      await expect(
        assertSafeUrl("http://169.254.169.254/latest/meta-data/"),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it("rejects 10.x private range", async () => {
      await expect(assertSafeUrl("http://10.0.0.1:8000/")).rejects.toThrow(
        UnsafeUrlError,
      );
    });

    it("rejects 192.168.x private range", async () => {
      await expect(assertSafeUrl("http://192.168.1.1/")).rejects.toThrow(
        UnsafeUrlError,
      );
    });

    it("rejects 172.16-31.x private range", async () => {
      await expect(assertSafeUrl("http://172.16.0.1/")).rejects.toThrow(
        UnsafeUrlError,
      );
      await expect(assertSafeUrl("http://172.31.255.255/")).rejects.toThrow(
        UnsafeUrlError,
      );
    });

    it("rejects IPv6 loopback", async () => {
      await expect(assertSafeUrl("http://[::1]:8000/")).rejects.toThrow(
        UnsafeUrlError,
      );
    });

    it("rejects IPv6 link-local", async () => {
      await expect(assertSafeUrl("http://[fe80::1]/")).rejects.toThrow(
        UnsafeUrlError,
      );
    });

    it("allows public IP literals", async () => {
      await expect(assertSafeUrl("http://1.1.1.1:8000/")).resolves.toBeUndefined();
      await expect(assertSafeUrl("http://8.8.8.8/")).resolves.toBeUndefined();
    });
  });

  describe("with DNS hostnames", () => {
    afterEach(() => {
      vi.doUnmock("node:dns/promises");
    });

    it("rejects when DNS resolves to a private IP", async () => {
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn().mockResolvedValue([
          { address: "127.0.0.1", family: 4 },
        ]),
      }));
      // Re-import to pick up the mock
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://internal.example.com/")).rejects.toMatchObject({
        name: "UnsafeUrlError",
        message: "hostname resolves to a private address",
      });
    });

    it("allows when DNS resolves to a public IP", async () => {
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn().mockResolvedValue([
          { address: "93.184.216.34", family: 4 },
        ]),
      }));
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://example.com/")).resolves.toBeUndefined();
    });

    it("rejects when DNS lookup fails (fail-closed)", async () => {
      // The old behavior passed unresolved names through — a rebinding
      // window (attacker's authoritative server refuses the guard's
      // lookup, resolves public for the real fetch). Now it refuses.
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
      }));
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://nonexistent.example.com/")).rejects.toMatchObject({
        name: "UnsafeUrlError",
        message: "hostname could not be resolved",
      });
    });

    it("rejects when DNS resolves to an empty result (fail-closed)", async () => {
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn().mockResolvedValue([]),
      }));
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://empty.example.com/")).rejects.toMatchObject({
        name: "UnsafeUrlError",
        message: "hostname could not be resolved",
      });
    });
  });

  describe("bypass via allowPrivate option", () => {
    it("allows private IPs when allowPrivate is true", async () => {
      await expect(
        assertSafeUrl("http://127.0.0.1:8000/", { allowPrivate: true }),
      ).resolves.toBeUndefined();
      await expect(
        assertSafeUrl("http://169.254.169.254/", { allowPrivate: true }),
      ).resolves.toBeUndefined();
    });
  });

  describe("invalid URLs", () => {
    it("rejects non-URL strings", async () => {
      await expect(assertSafeUrl("not-a-url")).rejects.toThrow(UnsafeUrlError);
    });

    it("rejects URLs without a hostname", async () => {
      await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(
        UnsafeUrlError,
      );
    });
  });

  describe("fetchGuardedRedirects", () => {
    // Public IP-literal hosts — no DNS involved, the guard checks the
    // literal directly (93.184.216.34 is a real public example-net IP;
    // TEST-NET/benchmark ranges are deliberately avoided because the
    // hardened guard blocks them).
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("follows redirects to public targets", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "http://93.184.216.34/run") {
            return new Response(null, { status: 302, headers: { location: "http://93.184.216.35/run" } });
          }
          return new Response("ok", { status: 200 });
        }),
      );
      const res = await fetchGuardedRedirects("http://93.184.216.34/run", { method: "POST" });
      expect(res.status).toBe(200);
    });

    it("refuses a redirect to a private address (the redirect SSRF vector)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })),
      );
      await expect(
        fetchGuardedRedirects("http://93.184.216.34/run", { method: "GET" }),
      ).rejects.toMatchObject({
        name: "UnsafeUrlError",
        message: "hostname resolves to a private address",
      });
    });

    it("refuses when the INITIAL url is private (fail-closed entry)", async () => {
      await expect(
        fetchGuardedRedirects("http://127.0.0.1:8000/run", { method: "POST" }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it("caps redirect loops", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://93.184.216.34/a" } })),
      );
      await expect(
        fetchGuardedRedirects("http://93.184.216.34/a", { method: "GET" }),
      ).rejects.toMatchObject({ name: "UnsafeUrlError", message: "too many redirects" });
    });

    it("applies 303 semantics (method → GET, body dropped)", async () => {
      const calls: Array<{ url: string; method: string; hasBody: boolean }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, method: init.method ?? "GET", hasBody: init.body != null });
          if (url === "http://93.184.216.34/x") {
            return new Response(null, { status: 303, headers: { location: "http://93.184.216.35/x" } });
          }
          return new Response("ok", { status: 200 });
        }),
      );
      await fetchGuardedRedirects("http://93.184.216.34/x", { method: "POST", body: "data" });
      expect(calls[0]).toMatchObject({ method: "POST", hasBody: true });
      expect(calls[1]).toMatchObject({ method: "GET", hasBody: false });
    });

    it("resolves relative Location headers against the current URL", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "http://93.184.216.34/deep/path") {
            return new Response(null, { status: 301, headers: { location: "/other" } });
          }
          if (url === "http://93.184.216.34/other") {
            return new Response("ok", { status: 200 });
          }
          throw new Error(`unexpected fetch to ${url}`);
        }),
      );
      const res = await fetchGuardedRedirects("http://93.184.216.34/deep/path", { method: "GET" });
      expect(res.status).toBe(200);
    });

    it("returns a 3xx without a Location header as-is", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 304 })),
      );
      const res = await fetchGuardedRedirects("http://93.184.216.34/x", { method: "GET" });
      expect(res.status).toBe(304);
    });

    it("strips Authorization/Cookie on a CROSS-ORIGIN redirect hop", async () => {
      // The manual loop re-sends init verbatim per hop; without the
      // spec's cross-origin credential strip a compromised backend could
      // 302 a run (carrying the agent JWT + the full conversation body)
      // to a third-party collector.
      const calls: Array<{ url: string; auth?: string; cookie?: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const h = new Headers(init.headers);
          calls.push({ url, auth: h.get("authorization") ?? undefined, cookie: h.get("cookie") ?? undefined });
          if (url === "http://93.184.216.34/run") {
            return new Response(null, { status: 302, headers: { location: "http://93.184.216.35/run" } });
          }
          return new Response("ok", { status: 200 });
        }),
      );
      const res = await fetchGuardedRedirects("http://93.184.216.34/run", {
        method: "POST",
        headers: { authorization: "Bearer agent-jwt", cookie: "session=abc" },
        body: JSON.stringify({ messages: ["whole conversation"] }),
      });
      expect(res.status).toBe(200);
      expect(calls[0]).toMatchObject({ auth: "Bearer agent-jwt", cookie: "session=abc" });
      // The hop: credentials gone. Same-origin hop below would keep them.
      expect(calls[1]).toMatchObject({ url: "http://93.184.216.35/run", auth: undefined, cookie: undefined });
    });

    it("keeps Authorization on a SAME-ORIGIN redirect hop", async () => {
      const calls: Array<{ url: string; auth?: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, auth: new Headers(init.headers).get("authorization") ?? undefined });
          if (url === "http://93.184.216.34/a") {
            return new Response(null, { status: 302, headers: { location: "http://93.184.216.34/b" } });
          }
          return new Response("ok", { status: 200 });
        }),
      );
      await fetchGuardedRedirects("http://93.184.216.34/a", {
        headers: { authorization: "Bearer agent-jwt" },
      });
      expect(calls[0]).toMatchObject({ auth: "Bearer agent-jwt" });
      expect(calls[1]).toMatchObject({ auth: "Bearer agent-jwt" });
    });

    it("rewrites 302 POST → GET and drops the body (spec redirect semantics)", async () => {
      const calls: Array<{ url: string; method: string; hasBody: boolean }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, method: init.method ?? "GET", hasBody: init.body != null });
          if (url === "http://93.184.216.34/x") {
            return new Response(null, { status: 302, headers: { location: "http://93.184.216.34/y" } });
          }
          return new Response("ok", { status: 200 });
        }),
      );
      await fetchGuardedRedirects("http://93.184.216.34/x", { method: "POST", body: "data" });
      expect(calls[0]).toMatchObject({ method: "POST", hasBody: true });
      expect(calls[1]).toMatchObject({ method: "GET", hasBody: false });
    });

    it("refuses a malformed Location header as UnsafeUrlError (not a bare TypeError)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://[::1" } })),
      );
      await expect(
        fetchGuardedRedirects("http://93.184.216.34/x", { method: "GET" }),
      ).rejects.toMatchObject({ name: "UnsafeUrlError", message: "invalid redirect location" });
    });
  });

  // The SaaS-mode forced SSRF guard lives in lib/config/saas.ts and is read
  // at module load time by safe-fetch.ts. We exercise it by stubbing
  // process.env.SAAS_MODE and re-importing the module fresh, so the
  // SSRF_GUARD_FORCE_ON constant picks up the new value.
  describe("SaaS mode forced guard", () => {
    const origSaas = process.env.SAAS_MODE;
    const origAllowPrivate = process.env.ALLOW_PRIVATE_ENDPOINTS;

    afterEach(() => {
      if (origSaas === undefined) delete process.env.SAAS_MODE;
      else process.env.SAAS_MODE = origSaas;
      if (origAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_ENDPOINTS;
      else process.env.ALLOW_PRIVATE_ENDPOINTS = origAllowPrivate;
      vi.resetModules();
    });

    it("ignores ALLOW_PRIVATE_ENDPOINTS=true under SaaS mode", async () => {
      process.env.SAAS_MODE = "true";
      process.env.ALLOW_PRIVATE_ENDPOINTS = "true";
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(
        fresh("http://127.0.0.1:8000/agent"),
      ).rejects.toMatchObject({
        name: "UnsafeUrlError",
        message: "hostname resolves to a private address",
      });
      // Cloud metadata endpoint must always be blocked on SaaS.
      await expect(
        fresh("http://169.254.169.254/latest/meta-data/"),
      ).rejects.toMatchObject({ name: "UnsafeUrlError" });
    });

    it("ignores the allowPrivate call option under SaaS mode", async () => {
      process.env.SAAS_MODE = "true";
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(
        fresh("http://10.0.0.1:8000/", { allowPrivate: true }),
      ).rejects.toMatchObject({ name: "UnsafeUrlError" });
    });

    it("still allows public endpoints under SaaS mode", async () => {
      process.env.SAAS_MODE = "true";
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://1.1.1.1:8000/")).resolves.toBeUndefined();
      await expect(fresh("http://8.8.8.8/")).resolves.toBeUndefined();
    });
  });

  describe("ALLOW_PRIVATE_ENDPOINTS opt-in (self-host only)", () => {
    const origAllowPrivate = process.env.ALLOW_PRIVATE_ENDPOINTS;

    afterEach(() => {
      if (origAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_ENDPOINTS;
      else process.env.ALLOW_PRIVATE_ENDPOINTS = origAllowPrivate;
      delete process.env.SAAS_MODE;
      vi.resetModules();
    });

    it("ALLOWS private URLs when set outside SaaS mode (the documented self-host opt-in)", async () => {
      // The positive half of the SaaS tests above: self-hosters pointing
      // the builder at a backend on their private network (e.g. a
      // docker-compose service) must be able to opt in explicitly.
      process.env.ALLOW_PRIVATE_ENDPOINTS = "true";
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://127.0.0.1:8000/agent")).resolves.toBeUndefined();
      await expect(fresh("http://10.0.0.1:8000/")).resolves.toBeUndefined();
      await expect(fresh("http://192.168.1.10:3000/")).resolves.toBeUndefined();
    });

    it("still blocks private URLs when unset (default)", async () => {
      delete process.env.ALLOW_PRIVATE_ENDPOINTS;
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://127.0.0.1:8000/agent")).rejects.toMatchObject({
        name: "UnsafeUrlError",
      });
    });
  });
});
