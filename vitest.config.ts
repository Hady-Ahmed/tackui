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
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
