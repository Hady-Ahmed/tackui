## Summary

Agent JWT secrets are no longer decrypted eagerly on every row read, and a secret that can't be decrypted now reports itself honestly as **undecryptable** instead of silently degrading to "secret-less". Row mapping is presence-only; the plaintext is resolved on demand at its genuine consumption points (run-token minting for self-managed agents, the admin surfaces' tri-state). The admin edit form shows an amber re-save nudge for undecryptable secrets, and self-managed JWT agents in that state fail their runs fast with an actionable message instead of calling the backend headerless and surfacing a confusing 401. Broken secrets log once per process instead of on every agents-list load.

## Related issue

Closes #82

## Changes

**Store (`lib/agents/agent-store.ts`, `lib/agents/agents.config.ts`)**

- `rowToEntry` no longer decrypts. It carries the raw stored value as `AgentEntry.jwtSecretStored` (ciphertext or legacy plaintext) and never attempts a decrypt — no more `[agent-store] failed to decrypt jwt_secret` noise per list load, no wasted work for rows whose secret the read never uses.
- New `resolveAgentSecret(entry)` — the single on-demand decryption point, returning the honest tri-state `{ status: "none" | "set" | "undecryptable", secret? }`:
  - an already-resolved plaintext (`entry.jwtSecret`, e.g. the registry's template/builder overrides) wins over the row copy — a live template's healthy secret is never shadowed by a stale row copy, and the row copy is never decrypted for catalog installs;
  - legacy plaintext (no `enc:v1:` prefix) passes through without a key;
  - a successful decrypt memoizes onto the entry (per-request objects, so the memo never goes stale);
  - a failure logs **once per process per agent** (keyed `orgId/id` — the composite row identity) and returns `undecryptable`, never a silent secret-less degrade.
- `PublicAgent` gains required `jwtSecretStatus` (`"none" | "set" | "undecryptable"`); `hasJwtSecret` stays presence-based (true also when undecryptable — a secret *is* stored). Raw `jwtSecret`/`jwtSecretStored` still never leave the server.
- `updateAgent`'s blank-preserve now writes the stored bytes back **byte-for-byte in every no-patch case** (previously an unrelated edit re-encrypted a decryptable secret with a fresh IV; the raw-preserve path is now unconditional). The documented recovery path — entering a fresh secret replaces undecryptable ciphertext — is unchanged.

**Run path (`lib/agents/registry.ts`)**

- `createAgent` resolves the secret on demand only when `authMode === "jwt"` and mints from the resolved plaintext (same HS256 token shape as before).
- An undecryptable secret is no longer treated as secret-less: the agent **stays listed** (a throw/skip at listing time crashes the client's "Agent not found after runtime sync"), no `Authorization` header is minted, and a guard middleware — registered before the context middleware — throws an actionable message at run time ("This agent's stored credential can't be decrypted … re-save the agent's JWT secret in the agents settings"), failing the run before any request reaches the backend. Applies to self-managed agents and to tombstoned catalog installs falling back to their row copy; live catalog installs are unaffected (template auth).

**Admin UI (`app/agents/page.tsx`)**

- The edit form's JWT-secret hint becomes the honest tri-state badge: **undecryptable** → amber "Stored secret can't be decrypted — the encryption key may have changed. Runs fail until it is re-saved: type a new value below and update the agent." (replaces the misleading secret-less/generic hint); healthy stored secret → the existing "Key set ✓" hint; nothing stored → the existing generic hint. The field stays blank either way (write-only contract) and blank submit still preserves the stored value.

**Tests** — see Test plan.

**Docs** — `docs/agent-registry.md` (secret handling + encryption-at-rest sections), `AGENTS.md` gotcha bullet, README secret-handling bullet, `CHANGELOG.md` entry under `[Unreleased]`.

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

## Security

No files under `lib/auth/`, `lib/billing/`, `lib/net/`, `lib/ratelimit/` are touched. The change is encryption-at-rest-adjacent, so the invariants were preserved deliberately and pinned by tests:

- **Write-only secrets hold:** `toPublicAgent` strips both `jwtSecret` and `jwtSecretStored`; tests assert neither key appears in any public response (`not.toHaveProperty`). The plaintext still exists only in server memory (resolver + minting).
- **The blank-preserve bypass is still closed:** a patch that omits `jwtSecret` cannot destroy or weaken a stored secret — including an undecryptable one (byte-for-byte preserve, tested for both the org-scoped and `bypassOrgScope` paths; a patch supplying a new secret still replaces it).
- **No silent security downgrade:** the old behavior masked a broken credential as "no credential configured" and sent headerless requests; the new fail-fast makes the broken state loud instead of quietly retrying without auth.
- **No new env vars; no secrets committed.**

## Test plan

**Verified by unit tests** (`npm run test`: 66 files, 1208 tests, all green):

- Presence-only mapping: a row with undecryptable ciphertext is listed/fetched with `jwtSecretStored` carried raw, `jwtSecret` undefined, and zero decrypt attempts (the old code's decrypt-failure log would have fired — a console-error spy proves it doesn't).
- `resolveAgentSecret` tri-state: `none` (nothing stored), `set` (healthy ciphertext, memoized onto the entry), `set` (legacy plaintext passthrough), `undecryptable` (garbage ciphertext → no plaintext), and override priority (an already-resolved plaintext wins over the stored copy without touching it).
- Log-once-per-process: three independent reads of the same broken row produce exactly one log line.
- `toPublicAgent` tri-state + `hasJwtSecret` presence semantics + raw-secret stripping for all three states.
- `updateAgent`: blank-preserve byte-for-byte (undecryptable ciphertext, org-scoped and bypass), patch-supplied secret replaces it (recovery path), concurrency serialization tests re-asserted through the resolver.
- Registry: mint from a legacy plaintext stored secret; tombstoned catalog install resolves and mints from its row copy; **live catalog install mints from the template secret even with an undecryptable row copy and never decrypts/logs the row copy**; undecryptable secret → agent still listed, no `Authorization` header, and the guard middleware throws the actionable re-save message at run time (before any backend request).
- Existing suites covering the install copy, builder routes, catalog, and the write-only contract were adapted where they read `AgentEntry.jwtSecret` back (now via `resolveAgentSecret`); the template store itself is untouched (its eager decrypt is explicitly healthy per the issue).

**Verified in a headless browser** (throwaway Playwright script against `npm run dev` in solo mode (`AUTH_DISABLED=true`) with a local Postgres and `DB_ENCRYPTION_KEY` set; dev server, scratch script, and throwaway `.env.local` deleted afterwards):

1. Opened `/agents`, created a custom agent via the "Connect an existing agent" form with `authMode: jwt` and a 40-char secret.
2. Opened its edit form → the "Key set ✓ — leave blank to keep existing…" hint rendered; `GET /api/agents` reported `jwtSecretStatus: "set"`, `hasJwtSecret: true`, and no `jwtSecret`/`jwtSecretStored` key in the response.
3. Corrupted the stored ciphertext directly in Postgres (`UPDATE agents SET jwt_secret='enc:v1:<garbage>'` — simulates key rotation), reloaded `/agents`, opened the edit form → the amber "Stored secret can't be decrypted …" warning rendered, "Key set ✓" was gone, and the secret field was still blank.
4. `GET /api/agents` for that agent reported `jwtSecretStatus: "undecryptable"`, `hasJwtSecret: true`.
5. Typed a new secret and saved → the hint reverted to "Key set ✓" and the API back to `"set"` (recovery path works through the real form → PATCH → list round-trip).
6. Created a second agent with `authMode: none` and no secret → API reported `jwtSecretStatus: "none"`, `hasJwtSecret: false` — none ≠ undecryptable.
7. The dev server log showed the decrypt-failure line once per process across 45 list loads (Next dev runs several worker processes; production is one process → one line).

**To confirm by hand:**

- The chat-facing error copy: run a self-managed JWT agent whose secret is undecryptable — the run should fail with "This agent's stored credential can't be decrypted…" instead of a backend 401. The unit tests prove the guard middleware throws before any backend request; the CopilotKit runner's finalize path (verified in the installed SDK source: `runAgent` rejection → `finalizeRun({ interruptionMessage })` → `RUN_ERROR` event carrying the message) is what delivers it to the chat UI, but the full round-trip needs a real per-agent-JWT backend.
- A catalog-installed agent with an undecryptable row copy running normally against a real catalog backend (unit-level: the template secret is minted and the row copy is never decrypted).
- After a real `DB_ENCRYPTION_KEY` rotation, the `/agents` edit form flags exactly the agents whose secrets were encrypted under the old key.

**Scope note (interpretation of one acceptance criterion):** "Catalog-installed agents with undecryptable row copies … are visually distinguishable from genuinely secret-less agents" is satisfied at the data level (`jwtSecretStatus` distinguishes `undecryptable` from `none` on every public response) and in the only UI surface that shows secret state — the edit form. Managed (catalog) rows have no edit form and no secret UI today (like their endpoint, their row config is curator-owned and hidden), so no new table/chip surface was added for them; if a visible per-row indicator is wanted, that's a small follow-up.

## Convention attestations

- Tests: added in `lib/agents/agent-store.test.ts` (presence-only mapping, tri-state, log-once, override priority, public tri-state), `lib/agents/registry.test.ts` (mint-on-demand from stored secrets, tombstoned row-copy fallback, live-template override with undecryptable row copy, fast-fail guard middleware), plus adapted read-back assertions in `app/api/catalog/[id]/install/route.test.ts`, `lib/catalog/template-store.test.ts`, and `components/builder/builder-form.test.tsx` (PublicAgent mock shape).
- eslint-disable / @ts-ignore / @ts-expect-error / any: none added.
- TODO/FIXME/HACK comments: none added.
- Docs: `docs/agent-registry.md` updated (secret handling + encryption-at-rest sections); `AGENTS.md` `jwtSecret` gotcha bullet updated; README "Secret handling" bullet updated.
- CHANGELOG.md: entry added under `[Unreleased]` (Changed).
- Security-sensitive files (lib/auth | lib/billing | lib/net | lib/ratelimit): not touched.
- Env vars: none added.
