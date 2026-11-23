## Summary

Bounded waiting for the keyed lock (#153): `withKeyedLock` waiters can no longer park
forever behind a wedged lock holder. A same-key waiter now times out after 30 seconds
and the per-key wait queue caps at 32 — both configurable per call via a new optional
`options` parameter (existing callers compile and behave unchanged on happy paths).
Giving up rejects with a new typed `KeyedLockUnavailableError` (stable
`code: "KEYED_LOCK_UNAVAILABLE"`, `reason` discriminates `"wait-timeout"` vs
`"queue-full"`), and both routes holding the lock surface it as a 503
"please try again" instead of the generic 500.

## Related issue

Closes #153

## Changes

- `lib/db/keyed-lock.ts`
  - New exported typed error `KeyedLockUnavailableError` (`code`
    `KEYED_LOCK_UNAVAILABLE`; `reason: "wait-timeout" | "queue-full"`).
  - New optional `withKeyedLock(key, fn, options?)` param: `waitTimeoutMs`
    (default `DEFAULT_LOCK_WAIT_TIMEOUT_MS` = 30 000, `Infinity` opts out) and
    `maxWaiters` (default `DEFAULT_MAX_LOCK_WAITERS` = 32, `Infinity` disables).
    Nonsense values (0, negative, NaN, fractional) reject with `RangeError` at the
    call instead of silently failing every contended acquire.
  - A timed-out waiter is removed from the FIFO queue before rejecting, so a later
    release hands the lock to the next living waiter — a handoff to an
    already-rejected waiter would strand the lock on a caller that stopped waiting.
    An admitted waiter's timer is cleared, so admission cancels the timeout.
  - Header docstring updated to describe the bounded-wait semantics (load-bearing
    narrative kept accurate, as the issue requested).
- `app/api/catalog/[id]/route.ts` — PATCH maps `KeyedLockUnavailableError` to
  **503** with its existing "Couldn't update the template — please try again." copy,
  checked after the 23505→409 branch; anything else still falls through to the 500.
- `app/api/credentials/route.ts` — PUT maps the same typed error to **503** with its
  existing "Couldn't save the credential — please try again." copy. Note: the issue
  decision names only the catalog route, but this route is the lock's other
  production caller (both are named in 9140d17, the commit introducing the
  primitive); the same rationale applies, so the same policy was applied here —
  flagged for confirmation in AGENT_QUESTIONS.md.
- Tests: `lib/db/keyed-lock.test.ts` (9 new tests: wait-timeout rejection with the
  typed error, timed-out-waiter-never-receives-a-handoff, admitted-before-timer,
  queue-full fail-fast at the 32 cap, per-call custom `maxWaiters`, FIFO handoff
  with both bounds armed, `Infinity` opt-out, defaults-armed sanity, `RangeError`
  validation) and the two route suites (503 mapping for both failure reasons +
  a guard that an unexpected store failure still 500s). No new files — colocated
  per the testing conventions.
- Docs: `docs/catalog.md` and `docs/security.md` semaphore sections now describe the
  bounded wait and the 503 mapping; AGENTS.md Gotchas gains the
  "`withKeyedLock` waits are bounded" bullet (new invariant for future callers:
  >30s-under-contention operations need a larger `waitTimeoutMs`).
- `CHANGELOG.md`: entry under `## [Unreleased]` (Changed).

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

No security-sensitive directories touched (`lib/db`, `app/api/catalog/[id]`,
`app/api/credentials`). The change is DoS-adjacent hardening, which is why
`docs/security.md` was updated: previously a wedged lock holder (e.g. hung socket
between pool checkout and query timeout) parked same-key waiters indefinitely, an
unbounded in-process accumulation; now waits are timed and capped, and a waiter that
gives up leaves the queue so the lock can never be stranded on an abandoned waiter.
The row's `FOR UPDATE` lock remains the serialization point — the semaphore stays
pool protection, so no correctness boundary moved.

## Test plan

Verified by unit tests:
- `lib/db/keyed-lock.test.ts` — 13 tests total: the 4 pre-existing FIFO/no-barging/
  release-on-reject/different-keys tests unchanged, plus 9 new: a waiter parked past
  `waitTimeoutMs` rejects with `KeyedLockUnavailableError` (`reason: "wait-timeout"`,
  stable `code`); a timed-out waiter is spliced from the queue and never receives a
  later handoff (the survivor gets the lock; the lock is free afterwards); an
  admitted waiter runs and releases normally past its own would-be timer mark;
  arrival #33 at the 32-waiter default cap fails fast with `reason: "queue-full"`
  without disturbing the queued FIFO; a custom `maxWaiters: 2` only gates arrivals
  configured with it; FIFO handoff holds with both bounds armed; `waitTimeoutMs:
  Infinity` waits indefinitely; defaults arm 30s/32 and don't misfire on a 120ms
  hold; nonsense bounds (0/-1/NaN/fractional) reject with `RangeError` and leave the
  lock usable.
- `app/api/catalog/[id]/route.test.ts` + `app/api/credentials/route.test.ts` — both
  failure reasons map to 503 with each route's existing "please try again" copy
  (nothing persisted on the credentials path); a non-typed error still yields the
  generic 500; all pre-existing route tests pass unchanged through a forwarding mock
  of `withKeyedLock`.
- Full suite: 64 files / 1185 tests passing, including the real-Postgres tier
  (Docker up locally) — the 8-concurrent-writer pool-exhaustion tests for both hot
  paths pass with the new defaults armed (holders ≤1.5s are far inside the 30s
  default).
- Gates run on the final code: `npm run lint` (0 errors; the 3 remaining warnings
  are pre-existing, in files this change doesn't touch), `npx tsc --noEmit`,
  `npm run test`. agent-builder/ untouched, so the uv/pytest gate doesn't apply.

To confirm by hand:
- On a dev instance, hold a template's lock from a second session (or simulate
  contention) and let a PATCH wait past 30s — the editor gets a "please try again"
  response, and a subsequent normal edit succeeds without a restart.

## Convention attestations

- Tests: added — 9 in `lib/db/keyed-lock.test.ts`, 3 in
  `app/api/catalog/[id]/route.test.ts`, 1 in `app/api/credentials/route.test.ts`
  (colocated `*.test.ts`, per CONTRIBUTING.md testing conventions).
- eslint-disable / @ts-ignore / @ts-expect-error / any: none added.
- TODO/FIXME/HACK comments: none added.
- Docs: `docs/catalog.md`, `docs/security.md`, AGENTS.md Gotchas bullet.
- CHANGELOG.md: entry added under `## [Unreleased]` (Changed).
- Security-sensitive files (lib/auth | lib/billing | lib/net | lib/ratelimit):
  not touched.
- Env vars: none added (bounds are code defaults + per-call options, per the
  issue decision).
