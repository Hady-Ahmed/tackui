/**
 * Pure safety helpers for e2e/web-server.mjs (issue #138).
 *
 * The harness has two operational hazards when it shares a machine with
 * anything else — a leftover process on one of its fixed ports, or a
 * second battery booting while one is running:
 *
 *   1. Port pre-check — before anything is started, every fixed harness
 *      port is probed with a real bind attempt (dependency-free, like the
 *      rest of the harness). An occupied port exits the harness with a
 *      one-line message naming the port, the holder, and the remedy,
 *      instead of a raw EADDRINUSE stack from a dying child.
 *
 *   2. Pid-liveness container sweep — the stale-container sweep at
 *      startup used to `docker rm -f` EVERY `tackui-e2e-*` container,
 *      including the LIVE one of a concurrently running battery (its DB
 *      container dies mid-run and every subsequent test fails). The
 *      container names embed the pid of the harness that created them
 *      (`tackui-e2e-pg-<pid>` / `tackui-e2e-app-<pid>`), so the sweep now
 *      removes only containers whose creating harness pid is provably
 *      dead. A live battery's container is never touched; crash residue
 *      (dead pid) is still swept by the next run.
 *
 * Everything here is side-effect-free and dependency-free so the vitest
 * tier can unit-test it without spawning servers or containers — the
 * liveness predicate and the tool output are injected/parameterized.
 */
import net from "node:net";

/**
 * Is the port bindable right now? Resolves true when free, false when
 * something already listens on it (a bind of the loopback address fails
 * with EADDRINUSE whether the occupier bound loopback or all interfaces).
 * Other bind errors reject — the caller decides what to report.
 */
export function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      if (err && err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    });
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Extract the harness pid embedded in a container's name, or null when
 * the name is not a harness container of the known shape
 * (`tackui-e2e-pg-<pid>` / `tackui-e2e-app-<pid>`).
 */
export function pidFromContainerName(name) {
  const match = /^tackui-e2e-(?:pg|app)-(\d+)$/.exec(String(name));
  return match ? Number(match[1]) : null;
}

/**
 * Which of the listed containers may be removed: exactly those whose
 * embedded harness pid is NOT alive. `isAlive(pid)` is injected (the
 * harness passes a process.kill(pid, 0) wrapper; tests pass a stub).
 * Names without a recognizable pid are NEVER returned — the sweep only
 * removes what it can prove dead, so an unknown name lingers rather than
 * risk destroying something live.
 */
export function selectStaleContainers(names, isAlive) {
  const stale = [];
  for (const name of names) {
    const pid = pidFromContainerName(name);
    if (pid === null) continue;
    if (!isAlive(pid)) stale.push(name);
  }
  return stale;
}

/** Collapse holder entries to one per pid (a process can hold many fds). */
function dedupeHolders(holders) {
  const seen = new Set();
  return holders.filter((h) => {
    if (seen.has(h.pid)) return false;
    seen.add(h.pid);
    return true;
  });
}

/**
 * Parse `ss -ltnp` output for listeners on `port`: the local-address
 * column ends with `:<port>`, and the process column carries
 * `users:(("name",pid=N,fd=M))` pairs (only visible for the reader's own
 * processes — root-owned holders show no process info, which the caller
 * reports as unidentified). Returns [{ name, pid }], deduped by pid.
 */
export function parseSsListeners(output, port) {
  const suffix = new RegExp(`:${port}$`);
  const pair = /\(\s*"([^"]+)"\s*,\s*pid=(\d+)/g;
  const holders = [];
  for (const line of String(output).split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (!columns.some((c) => suffix.test(c))) continue;
    for (const match of line.matchAll(pair)) {
      holders.push({ name: match[1], pid: Number(match[2]) });
    }
  }
  return dedupeHolders(holders);
}

/**
 * Parse `lsof -iTCP:<port> -sTCP:LISTEN -P -n` output (with its header
 * line) the same way: the NAME column ends with `:<port>`, COMMAND and
 * PID are the first two columns. Returns [{ name, pid }], deduped by pid.
 */
export function parseLsofListeners(output, port) {
  const suffix = new RegExp(`:${port}$`);
  const holders = [];
  const lines = String(output).split("\n");
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 2 || !columns[0] || !columns[1]) continue;
    if (!columns.some((c) => suffix.test(c))) continue;
    const pid = Number(columns[1]);
    if (!Number.isInteger(pid)) continue;
    holders.push({ name: columns[0], pid });
  }
  return dedupeHolders(holders);
}
