import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Untracked Python virtualenvs — vendored wheel JS (e.g. matplotlib
    // bundles) trips lint rules and poisons the local lint baseline. The
    // `.gitignore` `.venv/` entry is unanchored, so `uv sync` can create one
    // at the repo root as well as in `agent-builder/`.
    "agent-builder/.venv/**",
    ".venv/**",
  ]),
]);

export default eslintConfig;
