# Security Policy

## Supported versions

Only the latest release line receives security fixes. The project is pre-1.0 — there is no separate patch line.

| Version | Supported |
| --- | --- |
| `0.1.x` (current) | ✅ |
| Older | ❌ — upgrade to the latest |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Instead, please report it privately via one of:

- **GitHub Security Advisories** — the "Report a vulnerability" button on the [Security tab](https://github.com/Hady-Ahmed/tackui/security/advisories/new). This is the preferred channel; it lets the maintainers collaborate privately with you on a fix and credit your disclosure.
- **Email** — send details to the repository owner via the email listed on their GitHub profile. PGP is available on request.

Please include:

- A description of the issue and the impact you've assessed
- Steps to reproduce, or a proof-of-concept (a curl script, a test case, a one-pager)
- Affected versions (e.g. "current `main`, commit `abc123`)
- Any suggested fix or mitigation you have in mind

## Response time

- **Acknowledgement:** within 72 hours of the report.
- **Initial assessment + triage:** within 7 days.
- **Fix or mitigation:** depends on severity and complexity; the maintainer will communicate a timeline after triage and keep you informed of progress.

A fix will be released as soon as practical, with a GitHub Security Advisory published at the same time as (or shortly after) the patch release. Public disclosure is coordinated with the reporter.

## Scope

This policy covers the code in this repository. It does **not** cover:

- Vulnerabilities in third-party dependencies (report those upstream to the dependency's maintainer; this project tracks them via Dependabot)
- Issues in your own deployment's configuration (env vars, proxy setup, Stripe dashboard, OAuth provider settings) — see the README's [Security](./README.md#security) section for hardening guidance
- Self-hosted deployments running with `AUTH_DISABLED=true` outside a trusted network — that mode is explicitly single-user; exposing it publicly is a misconfiguration, not a vulnerability in the project

## Hardening your deployment

The README's [Security](./README.md#security) section covers the project's security posture in detail: the SSRF guard, rate limiting, session-cookie flags, `BETTER_AUTH_SECRET` enforcement, open-redirect protection, security headers, secret handling (write-only `langsmithApiKey`), and known limitations. Read it before deploying publicly.

## Acknowledgements

Reporters of accepted vulnerabilities will be credited in the GitHub Security Advisory and in `CHANGELOG.md` (unless they prefer to remain anonymous).
