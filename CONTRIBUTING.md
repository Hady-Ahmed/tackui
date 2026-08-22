# Contributing to TackUI

Thanks for your interest in contributing! This guide covers getting set up and the conventions to follow.

## Quick start

```bash
git clone https://github.com/Hady-Ahmed/agent-front-end.git
cd agent-front-end
npm install
cp .env.example .env.local   # then edit values
npm run dev                  # http://localhost:3000
```

For the full environment-variable reference, see [`.env.example`](./.env.example) and the README's [Environment Variables](./README.md#environment-variables) section. Solo / no-auth mode (`AUTH_DISABLED=true`) is the fastest way to get a running instance — no auth env vars required, every visitor is the single admin.

## Prerequisites

- **Node.js 20+** (the Dockerfile pins `node:20-alpine`)
- **Postgres 14+** for production/realistic local dev, OR run with the in-memory `pg-mem` emulator for tests (no Postgres required)
- A `DATABASE_URL` pointing at your Postgres instance (e.g. `postgres://user:pass@localhost:5432/agentui`)

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server at `http://localhost:3000` |
| `npm run build` | Production build |
| `npm run start` | Start the production server (after `build`) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | TypeScript type-check (no emit) |
| `npm run test` | Run the vitest suite (in-memory pg-mem, no Docker) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run migrate` | Run pending DB migrations manually (optional — `npm run dev` runs them automatically on boot via `instrumentation.ts`) |
| `npm run create-admin <email> <password> [name]` | Create/promote an admin user |

Type-checking is not wired into `npm run build` for speed — please run `npx tsc --noEmit` before pushing.

## Project architecture

Before making changes, read [`AGENTS.md`](./AGENTS.md) — it's the comprehensive guide to the project's architecture, conventions, agent registry, auth model, rate limiting, billing, and the full file structure. The README has a higher-level overview; AGENTS.md is the source of truth for implementation details.

## Testing conventions

When adding new functionality, add tests alongside it. The suite uses [vitest](https://vitest.dev) with an in-memory Postgres emulator (`pg-mem`) — no Docker, no cleanup between runs.

- **API routes** — test each exported handler (`GET`, `POST`, `PATCH`, `DELETE`) for success, not-found, and validation-failure cases. Construct `Request` objects directly and assert on `res.status` + `await res.json()`. Use `beforeEach` to clear the DB via the store's public API.
- **Store / library functions** — unit-test each exported function. Cover happy paths, edge cases (missing records, duplicates), and zod validation rejections.
- **Test files** — place `*.test.ts` next to the file under test (e.g. `lib/agents/agent-store.test.ts`, `app/api/agents/route.test.ts`).
- **External calls** — mock with `vi.stubGlobal` (e.g. `fetch` in `/api/agents/reachability-probe` tests) or `vi.mock(...)` for module-level mocks. Restore in `afterEach`.
- **No production code changes for testability** — the in-memory pg-mem emulator + vitest's `isolate: true` handle DB isolation without needing test-only exports. pg-mem doesn't support `WITH RECURSIVE` CTEs or cross-statement `ROLLBACK` — those paths have `.skip`'d tests, to be covered by a future testcontainers integration suite.

See the `AGENTS.md` "Testing conventions" section for the full rationale.

## Pull requests

1. **One feature per PR.** Keep PRs focused — easier to review, easier to revert. If a change spans multiple features, split it.
2. **Add tests for new functionality.** If you're adding an API route, store function, or security check, add tests covering the happy path + the failure path. Tests should pass under `npm run test` without external services.
3. **Run the checks locally before pushing:**
   ```bash
   npm run lint
   npx tsc --noEmit
   npm run test
   ```
   CI runs the same three commands on every PR.
4. **Don't commit secrets.** `.env.local` and `.env.production` are git-ignored. If you accidentally commit a secret, **rotate it immediately** and open a PR removing it from history (`git filter-repo` or BFG).
5. **Don't add `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `any`** without a strong justification in the PR description. The codebase has zero today; the goal is to keep it that way, especially in security-critical code (`lib/auth`, `lib/billing`, `lib/net`, `lib/ratelimit`).
6. **Don't add `TODO` / `FIXME` / `HACK` comments** without an accompanying issue link. Open the issue first, then reference it: `// TODO(#123): handle X`.
7. **Update `AGENTS.md`** when you change the project's structure, add a new agent kind, change the auth model, or modify the rate-limit/billing architecture. It's the architecture doc — keep it accurate.
8. **Use the PR template** (`.github/PULL_REQUEST_TEMPLATE.md`) as your PR description.

## Commit messages

Conventional Commits are preferred but not enforced:

```
feat(billing): add usage-based pricing support
fix(auth): prevent session fixation on password reset
docs: clarify agent-kind matrix in README
test(ratelimit): cover watchdog force-release path
chore: bump @copilotkit/runtime to 1.63
```

Scope is optional for small changes. The body should explain *why*, not *what* — the diff shows what.

## Branch naming

No strict convention. Descriptive names help: `feat/usage-pricing`, `fix/session-fixation`, `docs/agent-matrix`. Avoid `patch-1`-style names.

## Code style

- **TypeScript strict** — the `tsconfig.json` is strict. Don't loosen it.
- **Tailwind v4** for styling — class-based dark mode via `@custom-variant`. See `app/globals.css`.
- **No comments unless asked** — the codebase is comment-light by convention. Code should be self-documenting. When a non-obvious decision is made, a short comment explaining *why* is welcome; comments explaining *what* the code does are noise.
- **Follow existing patterns** — look at neighboring files before introducing a new library or pattern. The project uses `pg.Pool` directly (no ORM), `zod` for validation, `better-auth` for auth, `@copilotkit/runtime/v2` for the runtime. Match those choices.

## Security-sensitive changes

If your PR touches auth, billing, the SSRF guard, rate limiting, cookies, or any file in `lib/auth/`, `lib/billing/`, `lib/net/`, or `lib/ratelimit/`:

- Add tests for the new behavior AND the bypass attempt (what an attacker would try).
- Don't add `eslint-disable` or `any` — see above.
- Note the change in your PR description under a **Security** heading so it gets a careful review.

## Reporting vulnerabilities

See [`SECURITY.md`](./SECURITY.md). **Do not open a public issue for a security vulnerability.**

## Code of conduct

By participating, you agree to abide by the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions will be licensed under the [Apache License 2.0](./LICENSE) that covers the project.
