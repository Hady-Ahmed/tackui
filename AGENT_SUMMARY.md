## Summary

`installTemplate`'s fresh-INSERT path ended in a non-null assertion on its final `getAgent` read. The just-created agent row is unprotected after the INSERT commits — the org can delete it between that commit and the read — so the missing row surfaced through the install route's catch-all as a bare 500. This drops the assertion and throws the existing `TemplateInstallVanishedError` (introduced by PR #146 for the re-sync path), which the route already maps to a retryable 409; no route change was needed.

## Related issue

Closes #147 — same class as #135, fixed for `resyncInstalledAgent` in PR #146.

## Changes

- `lib/catalog/template-store.ts` — the fresh-install path's final read (`installTemplate`, formerly line 681) no longer uses `!`; a null result now throws `TemplateInstallVanishedError` with the same why-comment style as the re-sync path's fix. Retry semantics already work: the vanished id is gone, so a retry's `findInstalledAgentId` returns null and the retry takes the fresh-install path.
- `lib/catalog/template-store.test.ts` — one new test mirroring PR #146's store-test pattern, placed next to the existing vanish tests: it scripts the final org-scoped read (`WHERE id = $1 AND org_id = $2` — the initial lookup's SQL, `source_template_id = $2`, is untouched so the fresh path is taken naturally) to see the row gone while the INSERT lands for real, asserts `TemplateInstallVanishedError`, and asserts the row actually landed (`listAgents` length 1 — the vanish is post-commit, not a failed INSERT).
- `docs/catalog.md` — the "installed row can vanish mid-call" bullet in Install semantics now covers both final reads (re-sync's and the fresh install's own) and states the shared retry semantics.
- `CHANGELOG.md` — Fixed entry added under `[Unreleased]`, right after the #135 entry it parallels.

## Checklist

- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run test` passes (and I added tests for new behavior — see [CONTRIBUTING.md](../CONTRIBUTING.md) for the testing conventions)
- [ ] No `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `any` added without justification in this PR description
- [ ] No `TODO` / `FIXME` / `HACK` comments added without an accompanying issue link
- [ ] If this touches security-sensitive code (`lib/auth/`, `lib/billing/`, `lib/net/`, `lib/ratelimit/`), I've added tests for the bypass attempt (what an attacker would try) — see the **Security** section below
- [ ] If this changes architecture (agent registry, auth model, rate-limit/billing structure), I've updated the matching [`docs/*.md`](../docs/) file — and `AGENTS.md` Gotchas if the change introduced a new trap
- [ ] If this adds a new env var, I've added it to [`.env.example`](../.env.example) and the README's Environment Variables section
- [ ] No secrets committed (`.env.local` / `.env.production` stay git-ignored)

## Test plan

- **Verified by unit tests:** `lib/catalog/template-store.test.ts` gains "fresh install: the just-created row vanishing before the final read surfaces as the same typed error" — it arms `pgScript.queryScript` so the final org-scoped `getAgent` read returns empty while the initial lookup and the INSERT run against the real DB, then asserts `installTemplate` rejects with `TemplateInstallVanishedError` and that exactly one agent row landed (the INSERT committed before the scripted miss). The route's 409 mapping is already covered by the route test PR #146 added (`app/api/catalog/[id]/install/route.test.ts`, the `TemplateInstallVanishedError` → 409 case). Full suite: 64 files / 1186 tests passing.
- No browser verification was performed: the change is server-side store code only — no component, page, or builder-interface surface was touched, and no browser script ran in this session.
- **To confirm by hand:** the happy path is unchanged — installing a catalog card still shows "✓ Added to workspace". The 409 surfaces only when the just-created row is deleted mid-request (a deletion race not reproducible by clicking); if it does occur, the UI shows the same retryable install failure the re-sync path already produces.

## Convention attestations

- Tests: added — `lib/catalog/template-store.test.ts` (fresh-install vanish test asserting `TemplateInstallVanishedError` and the post-commit row state), following PR #146's scripted-lookup store-test pattern.
- eslint-disable / @ts-ignore / @ts-expect-error / any: none added.
- TODO/FIXME/HACK comments: none added.
- Docs: `docs/catalog.md` updated (Install semantics — the vanish bullet now covers both paths' final reads and retry semantics).
- CHANGELOG.md: entry added under `[Unreleased]` (Fixed).
- Security-sensitive files (lib/auth | lib/billing | lib/net | lib/ratelimit): not touched.
- Env vars: none added.
