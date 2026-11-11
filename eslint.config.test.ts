import { describe, expect, it } from "vitest";
import eslintConfig from "./eslint.config.mjs";

// Regression guard for #126 and #131: the flat-config globalIgnores entry
// must keep covering Python virtualenvs in both places `.gitignore`'s
// unanchored `.venv/` entry lets `uv sync` create them. Vendored wheel JS
// inside a venv (e.g. matplotlib bundles) trips lint rules and poisons the
// local lint baseline, so a refactor that silently drops either pattern
// re-breaks `npm run lint` for anyone with a venv on disk.
describe("eslint config globalIgnores", () => {
  const globalIgnoreEntries = eslintConfig
    .filter((entry) => "ignores" in entry && !("rules" in entry))
    .flatMap((entry) => entry.ignores);

  it.each(["agent-builder/.venv/**", ".venv/**"])(
    "ignores %s",
    (pattern) => {
      expect(globalIgnoreEntries).toContain(pattern);
    },
  );
});
