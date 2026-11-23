## Summary

First sign-up on a fresh database with auth enabled and no SMTP failed with a
500 and left an orphan `organization` row behind. The `session.create.before`
hook that creates the user's personal workspace wrote through the app's shared
`query()` pool, but Better Auth wraps email sign-up (user + account + session)
in one transaction on a dedicated connection — the hook's `member` insert could
not see the still-uncommitted `user` row from another connection, the
`member.userId` FK check failed, and the whole sign-up rolled back. The hook
now reads and writes through Better Auth's transaction-scoped adapter
(`getCurrentAdapter(ctx.context.adapter)`), so user, org, membership, and
session commit atomically. This also fixes `npm run create-admin` on a fresh
database, which goes through the same code path.

## Related issue

Fixes #208

## Changes

- **`lib/auth/personal-org.ts` (new)** — the personal-org logic, extracted out
  of `auth.ts`'s inline hook: `ensurePersonalOrg(adapter, session)` looks up the
  user's oldest owner membership (reuse) or creates the org + owner member rows
  (first sign-up) and returns the `activeOrganizationId` the session row should
  carry; `sessionCreateBeforeHook(session, ctx)` resolves the adapter Better
  Auth is currently executing on via `getCurrentAdapter(ctx.context.adapter)` —
  the transaction-scoped adapter inside the sign-up transaction, the base
  adapter outside it — and delegates. Fails closed when the endpoint context is
  missing (every session-creation path goes through a dispatched endpoint, so
  the context is always present in practice; guessing a connection is what
  caused #208).
- **`lib/auth/auth.ts`** — the inline `session.create.before` hook body is
  replaced by the imported `sessionCreateBeforeHook` (behavior unchanged, now
  on the correct connection). The `user.create.after` first-admin hook is
  untouched — it already runs post-commit via Better Auth's queued-hook
  machinery, so its app-pool writes were always correct.
- **`lib/auth/personal-org.test.ts` (new)** — regression tests in two tiers.
  The real-Postgres tier is the #208 regression test: pg-mem cannot emulate
  cross-connection transaction visibility, so only real Postgres can reproduce
  the failure (it uses the existing testcontainers harness, SKIPs when local
  Docker is down, runs on CI).
- **`lib/auth/auth.test.ts`** — removed the re-extracted raw-SQL tests for the
  session hook (that SQL no longer exists in production); kept the
  `user.create.after` tests unchanged; added a wiring pin asserting the Better
  Auth instance uses the exported transaction-adapter-aware hook.
- **Docs** — `docs/auth-and-orgs.md` now documents the connection-affinity
  invariant; a new AGENTS.md Gotchas bullet states the rule for any Better Auth
  database hook.

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

This PR touches `lib/auth/`. The change is fix-shaped, not guard-shaped: the
hook previously performed its writes on the wrong connection; it now performs
them on the transaction's own connection via the adapter Better Auth itself
uses for the surrounding writes. Threat-model notes:

- **No new privilege or scope change.** The org + member rows created are
  identical in content to before (`owner` membership, `personal-<id8>` slug);
  only the connection they are written on changed.
- **Fail-closed on missing context.** If the endpoint context were ever absent
  the hook now throws instead of silently writing to an arbitrary connection —
  a half-created org is never silently committed.
- **No bypass surface added.** No route, cookie, or session-verification logic
  changed; sign-in, sign-up, and session-refresh flows keep their existing
  Better Auth middleware chain.
- The `member.userId` FK constraint continues to be enforced by Better Auth's
  own migration DDL; the negative-control test proves a pool-based hook is
  rejected by that constraint.

## Test plan

**Verified by unit tests:**

- `lib/auth/personal-org.test.ts` (pg-mem tier, 5 tests): org + owner member
  created when none exists; existing owner membership reused without
  duplicates; org-name fallbacks (name → email → "My"); hook glue resolves the
  base adapter outside a transaction and fails closed on a null context — all
  exercised through the real Better Auth adapter.
- `lib/auth/personal-org.test.ts` (real-Postgres tier, 3 tests via the
  testcontainers harness): (1) `signUpEmail` on a fresh DB without SMTP commits
  user + account + org + member + session atomically, and the org name comes
  from the user row created inside the same transaction ("Alice 208's
  workspace" — a pool-based hook could not even read that row); (2) a
  subsequent `signInEmail` reuses the same org on the new session (2 sessions,
  1 member, 1 org); (3) negative control — the pre-fix pool-based hook
  reproduces #208 against real Postgres: signup rejects, user rows roll back
  to zero, and the autocommitted org row remains as an orphan with no member
  pointing at it.
- `lib/auth/auth.test.ts`: wiring pin — `auth.options.databaseHooks.session
  .create.before === sessionCreateBeforeHook`, so the instance cannot silently
  regress to an inline pool-based hook.
- Full suite: 65 files, 1190 tests passing.

**Verified in a headless browser:** a throwaway Playwright script
(chromium, headless) drove the real Next dev server booted with a throwaway
Postgres 16 container, auth enabled, no `RESEND_API_KEY` — the exact #208
scenario:

1. Open `/signup`, fill name/email/password, submit "Create account" → hard
   navigation to `/app` succeeded (pre-fix this 500s and shows the error
   banner), and the app shell rendered with the owner CTA visible.
2. A second fresh signup (different email) also landed on `/app`.
3. Logging in again as the first user succeeded and landed on `/app`.
4. Database assertions afterwards: 2 users, 2 orgs named from the users
   ("Browser Alice's workspace" — read from the in-transaction user row),
   2 owner memberships, all 3 session rows carry `activeOrganizationId`,
   0 orphan orgs.

The dev server, throwaway Postgres container, `.env.local`, and the script
were removed afterwards; the script was never committed.

**To confirm by hand:** on a fresh database with `BETTER_AUTH_SECRET`,
`DB_ENCRYPTION_KEY`, and no `RESEND_API_KEY`, sign up through the UI — the
account is created, lands in `/app`, and the workspace exists with the user as
owner. `npm run create-admin <email> <password>` on a fresh database now
completes instead of failing with a 500.

## Convention attestations

- Tests: added `lib/auth/personal-org.test.ts` (5 pg-mem + 3 real-Postgres
  tests) and 1 wiring-pin test in `lib/auth/auth.test.ts`; removed the
  re-extracted session-hook tests from `auth.test.ts` whose SQL no longer
  exists in production. Real-Postgres tests use the repo's existing
  testcontainers harness and skip with a console note when local Docker is
  down (per AGENTS.md), running for real on CI.
- eslint-disable / @ts-ignore / @ts-expect-error / any: none added.
- TODO/FIXME/HACK comments: none added.
- Docs: `docs/auth-and-orgs.md` updated (connection-affinity invariant for
  Better Auth database hooks); AGENTS.md Gotchas bullet added.
- CHANGELOG.md: entry added under [Unreleased] (Fixed).
- Security-sensitive files (lib/auth | lib/billing | lib/net | lib/ratelimit):
  `lib/auth/auth.ts` touched (hook wiring only) and new
  `lib/auth/personal-org.ts` added — see the Security section above.
- Env vars: none added.
