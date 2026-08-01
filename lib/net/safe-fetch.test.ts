import { describe, it, expect, vi, afterEach } from "vitest";
import { assertSafeUrl, UnsafeUrlError, isPrivateIp } from "./safe-fetch";

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
      ["1.1.1.1", false, "public DNS"],
      ["8.8.8.8", false, "Google DNS"],
      ["172.15.255.255", false, "just below private range"],
      ["172.32.0.0", false, "just above private range"],
      ["11.0.0.1", false, "public 11.x"],
      ["193.0.0.1", false, "public"],
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

    it("allows when DNS lookup fails (lets downstream fetch report)", async () => {
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
      }));
      vi.resetModules();
      const { assertSafeUrl: fresh } = await import("./safe-fetch");
      await expect(fresh("http://nonexistent.example.com/")).resolves.toBeUndefined();
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
});
