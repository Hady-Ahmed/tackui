## Summary

<!-- One or two sentences: what does this PR change and why? -->

## Related issue

<!-- "Fixes #123" / "Refs #123" / "N/A" -->

## Changes

<!-- Bullet list of the concrete changes. Group by area if large (API / UI / DB / tests). -->

-

## Checklist

- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run test` passes (and I added tests for new behavior — see [CONTRIBUTING.md](../CONTRIBUTING.md) for the testing conventions)
- [ ] No `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `any` added without justification in this PR description
- [ ] No `TODO` / `FIXME` / `HACK` comments added without an accompanying issue link
- [ ] If this touches security-sensitive code (`lib/auth/`, `lib/billing/`, `lib/net/`, `lib/ratelimit/`), I've added tests for the bypass attempt (what an attacker would try) — see the **Security** section below
- [ ] If this changes architecture (new agent kind, auth model, rate-limit/billing structure), I've updated [`AGENTS.md`](../AGENTS.md)
- [ ] If this adds a new env var, I've added it to [`.env.example`](../.env.example) and the README's Environment Variables section
- [ ] No secrets committed (`.env.local` / `.env.production` stay git-ignored)

## Security (if applicable)

<!-- If this PR touches auth, billing, SSRF, rate limiting, cookies, or any file in lib/auth, lib/billing, lib/net, lib/ratelimit — explain the threat model and how the change preserves it. Otherwise delete this section. -->

## Test plan

<!-- How did you verify this works? For UI changes, list the steps to reproduce the new behavior. For API changes, list the curl commands. -->
