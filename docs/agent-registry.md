# Agents

The agent registry: how agents are stored, added, tested, authenticated to
backends, and how user identity reaches backends. Agents are stored in a
Postgres table (`agents`, shared with Better Auth via the same `pg.Pool`) and
managed via the `/agents` admin page or the `/api/agents` REST API — no
restart is needed (why: [architecture.md](./architecture.md#agent-registry-runtime-side)).

## Adding an agent

Via the admin UI (`/agents` page → "Add agent" form) or `POST /api/agents` with:

```json
{
  "name": "Research Agent",
  "description": "LangGraph-powered web research assistant",
  "endpoint": "http://localhost:8001/agent"
}
```

Optional fields: `authMode` (defaults to `"none"`), `jwtSecret` (required when
`authMode` is `"jwt"`, ≥32 chars), `jwtScopes` (optional `string[]` —
only when the backend has `authorization=True` enabled).

`id` is **server-generated** (12-char random hex) — never send it in the
POST body. The response includes the generated `id`, which you use in
PATCH/DELETE URLs. The id is immutable after creation.

> **SSRF guard:** Creating or editing an agent with an endpoint that
> resolves to a private/internal IP (`127.x`, `10.x`, `192.168.x`,
> `172.16-31.x`, `169.254.x`, IPv6 equivalents) returns 400. Set
> `ALLOW_PRIVATE_ENDPOINTS=true` to opt in (for self-hosters running
> backends on the same host). Details: [security.md](./security.md#ssrf-guard).

Internal error messages on `POST /api/agents` are masked (raw `err.message`
could leak DB topology/schema); the full error is logged server-side.

### REST smoke test

After running migrations, add an agent via the admin UI (`/agents`) or REST:

```bash
# AUTH_DISABLED=true (solo mode) — no session cookie needed.
# Otherwise sign in first and pass `-b cookies.txt`.
#
# If the endpoint is on localhost or a private IP, set ALLOW_PRIVATE_ENDPOINTS=true
# first — the SSRF guard on POST/PATCH will 400 otherwise.
#
# `id` is server-generated (12-char random hex) — do NOT send it in the body.
# The response includes the generated `id`, which you use in PATCH/DELETE URLs.
curl -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","description":"smoke test","endpoint":"http://localhost:8000/agent"}'
# → 201 { "id": "a1b2c3d4e5f6", "name": "Test", ... }

curl http://localhost:3000/api/agents                 # list
curl -X PATCH http://localhost:3000/api/agents/a1b2c3d4e5f6 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Renamed"}'                              # update (id from URL)
curl -X DELETE http://localhost:3000/api/agents/a1b2c3d4e5f6   # delete
```

`description` is required (zod-validated). The PK is composite `(id, org_id)`
(migration 0003) — the same id can exist in different orgs (matches the
app-level org scoping on every query). 48 bits of entropy makes intra-org
collisions effectively impossible; the 23505 catch in the POST handler is a
loud-error safety net, not a retry path.

## Test connection

Both the admin form and the agents table have a "Test connection" button that
hits `POST /api/agents/reachability-probe`. This performs a server-side `GET`
to the endpoint with a 5s timeout and reports reachability. It catches URL
typos and down servers — it does **not** validate auth, AG-UI protocol
compliance, or that the agent will actually run.

The sidebar shows a status dot per manual agent (gray = untested, green =
reachable, red = unreachable), re-tested on window focus — rendered as a
corner overlay on the row's avatar. Rows lead with an agent avatar (the
template's emoji icon for catalog agents, or the first-letter placeholder
when the template has none);
the status dot rides the avatar's corner in both sidebar modes. Managed
(catalog) agents show no probe dot — their endpoint never reaches the client,
so the sidebar can't probe them; connection health is the curator's
responsibility (`/admin` → Test connection). The corner carries state flags
instead: amber = Paused, blue = plan-locked.

The probe applies the same `assertSafeUrl` SSRF guard as agent create/edit —
so it cannot be used to port-scan internal services or hit cloud-metadata
endpoints. Any logged-in user can probe (the sidebar's status dots need it
for members too), but only public URLs are allowed. Raw error messages are
masked in the response (they can leak internal hostnames via DNS errors); the
full error is logged server-side via `console.error("[reachability-probe] ...")`.

## User identity forwarding

For `agui` agents, the runtime injects the authenticated user's id into
`input.forwardedProps.user_id` on every run (Agno's documented convention
for anonymous-caller attribution — Agno's `/agui` interface reads
`forwardedProps.user_id` to key per-user memory and sessions). This is
done server-side in `lib/agents/registry.ts`: `getAgents(request)` already
resolves the user per-request, and the constructed `HttpAgent` gets a
`FunctionMiddleware` via `agent.use()` that enriches `forwardedProps`
before forwarding to the backend. The value is the Better Auth user UUID
(or `"local"` in solo mode), never trusting client-supplied identity.

Other client-supplied `forwardedProps` fields are preserved (spread, not
overwritten) — only `user_id` is set, and server-side, never trusted from
the client.
The middleware survives CopilotKit's per-run `agent.clone()` (the SDK's
`clone()` copies the `middlewares` array). `forwardedProps.user_id` is
sent in **both** auth modes — additive, not either/or. When a valid JWT is
present, Agno pins to `sub` and ignores `forwardedProps.user_id`; when no
JWT (`authMode: "none"`), Agno uses it. Other AG-UI backends pick whichever
they prefer.

## Per-agent JWT authentication

`agui` agents support optional per-agent JWT auth (HS256) so the runtime
can authenticate to backends that require it (e.g. Agno with
`AuthMiddleware` / `authorization=True`). This is opt-in per agent via
the admin form (`/agents` page) or the REST API.

**How it works:**

- Each agent has an `authMode` field: `"none"` (default, anonymous) or
  `"jwt"`. When `"jwt"`, the agent also stores a `jwtSecret` (shared
  HS256 signing secret, ≥32 chars).
- On every run, `lib/agents/registry.ts` mints a short-lived JWT
  (`exp: +1h`) with `sub` = the authenticated user's Better Auth id,
  signs it with the agent's `jwtSecret`, and sends it as
  `Authorization: Bearer <token>` on the HTTP request to the backend.
- The backend verifies the signature (proving tackui minted it) and
  uses `sub` to identify the caller. **Authorization (what the user can
  do) stays the backend's job** — tackui only vouches for *who* the user
  is. The JWT carries no audience claim in v1.
- **Optional `jwtScopes`**: when configured, the JWT includes a `scopes`
  claim (a `string[]`) so backends with `authorization=True` enabled
  (e.g. Agno's `AuthMiddleware` with RBAC) can check permission scopes.
  Only needed when the backend requires specific scopes — omit entirely
  when the backend's authorization is off (the default). Set scopes per
  agent to match what the backend expects (e.g. `["agents:run"]` or
  `["app:superadmin"]`).
- To configure: set `authMode: "jwt"` on the agent, set `jwtSecret` to
  the same value as the backend's JWT verification key (e.g. Agno's
  `JWT_VERIFICATION_KEY` env var), and optionally set `jwtScopes` to
  the scopes the backend requires.

**Secret handling:** `jwtSecret` is **write-only** — accepted on POST/PATCH
but never returned in GET responses. `PublicAgent.hasJwtSecret: boolean`
replaces the raw value. The admin edit form shows "Key set ✓" when true;
submitting a blank field preserves the existing value. RS256 (asymmetric)
and audience claims are future enhancements. The encryption boundary lives
entirely inside `lib/agents/agent-store.ts` (see below); plaintext exists
only in server memory while minting run tokens.

## Encryption-at-rest for agent JWT secrets

Agent `jwt_secret` values are encrypted at rest with **AES-256-GCM**
(`lib/crypto/encrypt.ts`) so a leaked DB dump/backup alone does not
expose backend JWT verification keys.

- **Key:** `DB_ENCRYPTION_KEY` env var — 64 hex chars = 32 bytes
  (generate with `openssl rand -hex 32`), loaded lazily + cached.
  Malformed key throws (boot backfill surfaces it loudly).
- **Stored format:** `enc:v1:<iv_b64>:<ciphertext_b64>:<tag_b64>` in
  the existing TEXT column — no schema migration. Random 12-byte IV
  per write, 16-byte auth tag (tamper detection). The versioned prefix
  makes values self-describing and format-evolution possible.
- **Boundary:** encryption lives entirely inside `lib/agents/agent-store.ts`
  — `createAgent`/`updateAgent` encrypt before the INSERT/UPDATE,
  `rowToEntry` decrypts on read. Everything downstream (registry JWT
  minting, `toPublicAgent` stripping, blank-preserve PATCH) works
  unchanged on plaintext `AgentEntry.jwtSecret`.
- **Plaintext fallback (documented):** when `DB_ENCRYPTION_KEY` is
  unset, secrets are stored as plaintext — loud warning at boot
  (instrumentation.ts) + once per process on write. Keeps zero-config
  self-host working; set the key to get encryption.
- **Boot backfill** (`lib/crypto/backfill.ts`, wired into
  `instrumentation.ts`): idempotent pass that re-encrypts legacy
  plaintext rows (`jwt_secret NOT LIKE 'enc:v1:%'`) so existing
  deployments are protected without re-editing every agent. Skipped
  (with warning) when no key is configured.
- **Graceful decrypt failure:** a rotated/missing key or tampered value
  logs `[agent-store] failed to decrypt jwt_secret` and treats that
  agent as secret-less (backend returns 401) — other agents and the
  rest of the app keep working.
- **Key rotation:** changing `DB_ENCRYPTION_KEY` invalidates existing
  ciphertexts (GCM auth fails). Re-save each agent's JWT secret after
  rotation (the value itself doesn't change — only the encryption key).

## Future / extension points

- **RS256 (asymmetric) JWT auth** — v1 uses HS256 (symmetric shared
  secret). RS256 lets the private key never leave tackui (backend holds
  only the public key), but requires PEM key management + rotation
  story. Add as an alternative `jwtAlgorithm` field per agent.
- **JWT audience claims** — v1 sends only `sub` (who the user is) +
  optional `scopes` (what the backend allows). An audience (`aud`) claim
  is deliberately omitted — add an optional `jwtAudience` field if a
  backend genuinely requires it (rare).
- **Per-agent ACL (`agent_acl` table)** — restrict specific agents to
  specific users/groups (e.g. HR agent only visible to HR team). Group
  resolution should delegate to the IdP (OIDC token claims) when SSO is
  configured, falling back to an app-managed group table for
  email/password only. Separate from org_id (which is isolation, not
  sharing).
