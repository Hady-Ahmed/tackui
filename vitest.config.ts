import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts"],
    isolate: true,
    // The real-Postgres (testcontainers) tests pay a container-start cost
    // on their first test — a few seconds that stretches well past the
    // 5s default whenever the Docker daemon is busy (parallel CI jobs,
    // other suites' containers). A timeout there fails a green test, so
    // the budget is generous; pg-mem tests finish in milliseconds either
    // way.
    testTimeout: 30_000,
    // Same economics, but for hooks — a file's FIRST real-PG test pays the
    // container start inside beforeEach, and several files start their
    // containers concurrently on a 2-core CI runner. The 10s default blew
    // the budget on Node 24 CI (#90), and the abandoned hook then raced
    // the next hook's migrations on the same container (concurrent CREATE
    // TABLE → pg_type duplicate-key crash). The mutex in test-postgres.ts
    // makes that race structurally impossible; this budget keeps the hook
    // alive long enough to finish in the first place.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
