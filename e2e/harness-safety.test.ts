/**
 * Unit tests for the e2e harness's pure safety helpers
 * (e2e/harness-safety.mjs, issue #138). No servers or containers are
 * spawned beyond a loopback listener inside these tests — the point of
 * the module split is that everything except the raw bind probe is a
 * plain function over strings and callbacks.
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  parseLsofListeners,
  parseSsListeners,
  pidFromContainerName,
  probePort,
  selectStaleContainers,
} from "./harness-safety.mjs";

describe("pidFromContainerName", () => {
  it("extracts the pid from pg and app container names", () => {
    expect(pidFromContainerName("tackui-e2e-pg-12345")).toBe(12345);
    expect(pidFromContainerName("tackui-e2e-app-987")).toBe(987);
  });

  it("returns null for anything that is not a known harness container", () => {
    expect(pidFromContainerName("tackui-e2e-pg-")).toBe(null);
    expect(pidFromContainerName("tackui-e2e-pg-notapid")).toBe(null);
    expect(pidFromContainerName("tackui-e2e-pg-12x")).toBe(null);
    expect(pidFromContainerName("tackui-e2e-other-123")).toBe(null);
    expect(pidFromContainerName("tackui-e2e-pg-123-extra")).toBe(null);
    expect(pidFromContainerName("postgres")).toBe(null);
    expect(pidFromContainerName("")).toBe(null);
  });
});

describe("selectStaleContainers", () => {
  const alive = (pid: number) => pid % 2 === 0; // stub: even pids live

  it("removes only containers whose harness pid is dead", () => {
    expect(
      selectStaleContainers(
        ["tackui-e2e-pg-2", "tackui-e2e-pg-3", "tackui-e2e-app-4"],
        alive,
      ),
    ).toEqual(["tackui-e2e-pg-3"]);
  });

  it("never touches names without an embedded pid — sweep only the provable", () => {
    expect(
      selectStaleContainers(
        ["tackui-e2e-pg-notapid", "postgres", "tackui-e2e-pg-3"],
        alive,
      ),
    ).toEqual(["tackui-e2e-pg-3"]);
  });

  it("removes nothing when every harness pid is alive (concurrent battery)", () => {
    expect(selectStaleContainers(["tackui-e2e-pg-2", "tackui-e2e-app-4"], alive)).toEqual(
      [],
    );
  });

  it("returns an empty list for empty input", () => {
    expect(selectStaleContainers([], alive)).toEqual([]);
  });
});

describe("parseSsListeners", () => {
  const ssOutput = [
    "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    "LISTEN 0      511        127.0.0.1:3990      0.0.0.0:*     " +
      'users:(("next-server",pid=41234,fd=18))',
    "LISTEN 0      4096       127.0.0.1:3998      0.0.0.0:*     " +
      'users:(("node",pid=41300,fd=20))',
    "LISTEN 0      511            0.0.0.0:39990      0.0.0.0:*     " +
      'users:(("decoy",pid=99,fd=5))',
  ].join("\n");

  it("finds the listener on the exact port and no others", () => {
    expect(parseSsListeners(ssOutput, 3990)).toEqual([
      { name: "next-server", pid: 41234 },
    ]);
    expect(parseSsListeners(ssOutput, 3998)).toEqual([{ name: "node", pid: 41300 }]);
  });

  it("does not match a longer port that merely ends with the digits", () => {
    expect(parseSsListeners(ssOutput, 3999)).toEqual([]);
    expect(parseSsListeners(ssOutput, 39990)).toEqual([{ name: "decoy", pid: 99 }]);
  });

  it("dedupes one process holding several fds on the port", () => {
    const duplicated =
      "LISTEN 0 511 127.0.0.1:3990 0.0.0.0:* " +
      'users:(("node",pid=7,fd=18),("node",pid=7,fd=19))';
    expect(parseSsListeners(duplicated, 3990)).toEqual([{ name: "node", pid: 7 }]);
  });

  it("returns [] when the port line carries no process info (foreign owner)", () => {
    const opaque = "LISTEN 0 511 0.0.0.0:3990 0.0.0.0:*";
    expect(parseSsListeners(opaque, 3990)).toEqual([]);
  });

  it("returns [] for empty output", () => {
    expect(parseSsListeners("", 3990)).toEqual([]);
  });
});

describe("parseLsofListeners", () => {
  const lsofOutput = [
    "COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
    "node    41234 hadya   24u  IPv4  0x1a2b      0t0  TCP 127.0.0.1:3990 (LISTEN)",
    "node    41300 hadya   20u  IPv4  0x1a2c      0t0  TCP *:3998 (LISTEN)",
  ].join("\n");

  it("finds the listener on the exact port", () => {
    expect(parseLsofListeners(lsofOutput, 3990)).toEqual([
      { name: "node", pid: 41234 },
    ]);
    expect(parseLsofListeners(lsofOutput, 3998)).toEqual([
      { name: "node", pid: 41300 },
    ]);
  });

  it("returns [] when nothing listens on the port", () => {
    expect(parseLsofListeners(lsofOutput, 3999)).toEqual([]);
  });

  it("returns [] for empty output", () => {
    expect(parseLsofListeners("", 3990)).toEqual([]);
  });

  it("dedupes one process holding several fds on the port", () => {
    const duplicated = [
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
      "node 7 u 18u IPv4 0x0 0t0 TCP 127.0.0.1:3990 (LISTEN)",
      "node 7 u 19u IPv4 0x0 0t0 TCP 127.0.0.1:3990 (LISTEN)",
    ].join("\n");
    expect(parseLsofListeners(duplicated, 3990)).toEqual([{ name: "node", pid: 7 }]);
  });
});

describe("probePort", () => {
  /** The bound port of a listening loopback server (narrowed, no casts). */
  function portOf(server: net.Server): number {
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("server is not listening on a TCP port");
    }
    return addr.port;
  }

  it("reports a free port as free", async () => {
    // Ask the OS for a genuinely free port, then probe it after release.
    const free = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const port = portOf(srv);
        srv.close(() => resolve(port));
      });
    });
    expect(await probePort(free)).toBe(true);
  });

  it("reports an occupied port as occupied", async () => {
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = portOf(srv);
    try {
      expect(await probePort(port)).toBe(false);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});
