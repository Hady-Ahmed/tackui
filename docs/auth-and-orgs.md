# Auth & Orgs

Authentication (Better Auth), access control, and workspace (org) management.

## Overview

Auth is powered by [Better Auth](https://better-auth.com) with:

- **Email/password** sign-up/sign-in
- **Social login** (Google, GitHub) — only enabled if env vars are set
- **OIDC SSO** via `genericOAuth` plugin — for self-hosters with their own IdP
  (Keycloak, Authentik, Okta, Entra, etc.)
- **Organizations** via `organization` plugin — personal-org pattern: every
  user gets a personal workspace on signup. Agents and threads are scoped to
  the active org. Enables team invites + multi-workspace switching.
- **Admin roles** via `admin` plugin — `admin` (platform superuser) and `user`
  roles. Org-scoped roles (owner/admin/member) come from the `organization`
  plugin.
- **Auth-disabled mode** — `AUTH_DISABLED=true` makes everyone the single
  admin. A real solo org row is created on boot so `org_id` is always
  populated (NOT NULL on all tables). Useful for local dev or single-user
  self-hosted deployments.

Session-cookie `secure` is pinned to `NODE_ENV === "production"` (not Better
Auth's `secure: "auto"` default, which depends on proxy header forwarding).

Better Auth's built-in rate limiting (sign-in/sign-up per-IP limits) and the
app-level layers are documented in [security.md](./security.md#rate-limiting).

## Auth architecture

The full request-flow diagram (auth + API routing) lives in
[architecture.md](./architecture.md#request-flow).

The `app/api/auth/[...all]/route.ts` handler mounts Better Auth; the enabled
providers are exposed to the login UI via `GET /api/auth/config`
(`lib/auth/use-auth-config.ts` fetches it once per page load).

### Boot

- `BETTER_AUTH_SECRET` — the app **throws on boot** if unset when
  `AUTH_DISABLED !== "true"`. Prevents silent session forgery via a
  publicly-known fallback. The `"solo-mode-no-sessions"` fallback constant in
  `lib/auth/auth.ts` is unreachable by construction when auth is enabled — a
  tripwire against a future refactor removing the boot throw.
- Better Auth's tables are created automatically on boot (`ensureAuthTables()`
  in `instrumentation.ts`); see
  [architecture.md](./architecture.md#postgres-auth--agent-store) for the
  shared pool.
- **First user becomes admin:** the `databaseHooks.user.create.after` hook in
  `lib/auth/auth.ts` promotes the first user to `admin` role (bootstrap only).
  Personal org + owner membership creation happens in the
  `databaseHooks.session.create.before` hook — it checks if the user already
  has an owner membership; if not (first signup — `user.create.after` is
  deferred to post-transaction by Better Auth so it hasn't run yet), it
  creates the org + member rows in-transaction, then sets
  `activeOrganizationId` on the session. This ensures every auth path (email
  signup, login, social, OIDC) gets a correct `activeOrganizationId`. The
  `npm run create-admin` script can also create/promote an admin explicitly.
- Solo mode creates a real org row on boot (`lib/auth/solo-org.ts` —
  `ensureSoloOrg`) so `org_id` is always populated.

### Request user resolution

- `getCurrentUser()` (`lib/auth/context.ts`) — resolves the user from the
  session cookie via `auth.api.getSession()`. Used by REST API routes. Returns
  `getSyntheticAdmin()` (async, resolves the solo org id) when
  `AUTH_DISABLED=true`.
- `getRequestUser(request)` — same but takes a `Request` object. Used by the
  CopilotKit runtime route.
- `getRunnerUser()` (`lib/auth/request-context.ts`) — reads the user from
  `AsyncLocalStorage`. Used by `PostgresAgentRunner` (which has no access to
  the request). The ALS context is set by wrapping the CopilotKit handler in
  `runWithUserAsync()` in the runtime route. Carries `orgId` alongside
  `id`/`role`/`name`/`email`.
- `getSyntheticAdmin()` (`lib/auth/context.ts`) — async, resolves the solo
  org id from the DB on first call (see `lib/auth/solo-org.ts`). The synthetic
  admin has `orgId` populated so all scoping code works identically in solo
  mode and SaaS mode.

## Access control

- **Platform admin** (`admin` role from the `admin` plugin): Superuser for
  user management (ban/unban, set roles across all orgs — `users-admin.tsx`
  on `/admin`). Can manage agents in their own org (same as org owners). Does
  NOT bypass org scoping for threads or agents — sees only their own org's
  data.
- **Org owner/admin** (from the `organization` plugin's `member` table): Can
  manage agents (create/edit/delete) in their own org. Can use all agents and
  see their own threads in the org. Cannot manage users (platform-level).
- **Org member**: Can use agents and their own threads. Cannot manage agents.
- **Agent management authorization:** `canManageAgents(user)` in
  `lib/auth/context.ts` — returns true for platform admins (short-circuit) or
  org owners/admins (via `member` table lookup). Used by POST/PATCH/DELETE
  `/api/agents` routes. The client mirrors this via
  `GET /api/auth/can-manage-agents` → `useCanManageAgents()` hook. The chat
  empty-state CTA uses it too: owners/admins see "Add your first agent →",
  others see "ask your administrator to add one".
- **Org scoping:** Agents and threads are scoped by `org_id` (NOT NULL on
  `agents` + `thread_metadata`). `listAgents(orgId)`, `getAgent(id, orgId)`,
  `listThreads()` (filters cache by `organizationId === orgId`) all scope by
  the user's active org. No bypass for any role.
- **Thread scoping:** Threads are scoped per user + per org. `listThreads`
  filters by `createdById === userId && organizationId === orgId` via ALS.
  `deleteThread`/`renameThread` check ownership (owner or org-mate). No
  bypass for any role.

## Org switcher, invitations, member management

(SaaS team plan + self-host multi-user.)

- `components/org-switcher.tsx` — pure switcher dropdown. Self-renders
  only when the user belongs to >1 org (Free/Pro users with one personal
  org never see it; appears when they create additional workspaces or get
  invited to someone else's team). Shows per-org plan badges (Free/Pro/Team
  + seat count) in the dropdown. Switching calls
  `authClient.organization.setActive` then hard-navigates to `/app`.
- `components/new-workspace-dialog.tsx` — create-new-workspace modal,
  always available on SaaS (rendered from the account menu's "New
  workspace" button, not the switcher, so it's reachable even when the
  user has only one org and the switcher is hidden). Calls
  `authClient.organization.create`. New workspaces start on Free (3
  agents, 1 member, no invites); upgrade to Team from the account menu
  after switching to the new workspace.
- `components/invite-dialog.tsx` — invite-by-email modal for org
  owners/admins. Calls `authClient.organization.inviteMember`. Shows a
  live seats-remaining counter from `/api/org`; the server-side
  `membershipLimit` is the backstop (returns
  `ORGANIZATION_MEMBERSHIP_LIMIT_REACHED` past the cap).
- `app/app/invitations/page.tsx` — accept/reject pending invitations
  (`authClient.organization.listUserInvitations` +
  `acceptInvitation`/`rejectInvitation`). Reads `organizationName`
  (top-level string in better-auth's response, not a nested object).
  Refreshes the `useInvitations` cache on accept/reject so the
  account-menu badge updates immediately.
- `app/app/members/page.tsx` — workspace member management (org
  owners/admins). Roster via `listMembers` with role badges; remove a
  member (inline confirm) via `removeMember`; change a member's role
  (member↔admin↔owner) via `updateMemberRole` — the Owner option
  appears in the dropdown only when the viewer is an owner, enabling
  ownership transfer: promote someone to owner, then Leave (the Leave
  button appears once `ownerCount > 1`). Cancel a pending invitation
  via `cancelInvitation` + `resetInvitationsCache`. Non-admins see
  only the roster + a **Leave** button on their own row (self-removal
  via `removeMember` — better-auth guards the sole-owner case with
  `YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER`; the UI hides
  the Leave button entirely when the viewer is the sole owner rather
  than offering a dead button). The Remove button hides when the
  target is an owner and the viewer isn't (server blocks admins from
  removing owners). After every mutation the page calls
  `useOrgs().refresh()` so the invite dialog's live seats counter +
  the account-menu member count update everywhere. An **over-limit
  banner** (amber) surfaces the post-cancellation state where a
  downgraded Team org has more members than the Free 1-member cap —
  informational only; the server blocks new invites via
  `membershipLimit`, nothing breaks. Redirects to `/app` under solo
  mode (no multi-user meaning). The account menu's "Manage members"
  link is gated identically to "Invite member" (`canManage &&
  maxMembers === null` — self-host or Team plan). Billing buttons
  (Upgrade plan + Manage subscription) in the account menu are
  `canManage`-gated (owner/admin only) to match the server's
  `canManageAgents` check — members no longer see dead buttons that
  403.
- `lib/org-members.ts` — typed wrappers around the better-auth
  organization client (`listMembers`, `removeMember`,
  `updateMemberRole` (accepts `"owner"` for ownership transfer),
  `listInvitations` (filters to `status === "pending"` — better-auth
  returns all invitations incl. accepted/rejected/cancelled, never
  deleting rows), `cancelInvitation`). Pure API mapping — returns
  `{data, error}` with the error `code` preserved so the UI can map
  `YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER` and
  `YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER` to friendly messages.
  No new API routes — these call `/api/auth/organization/*` via the
  mounted better-auth handler. Permission checks (owner/admin can
  remove; sole owner can't leave; non-admins blocked) are enforced
  server-side by better-auth; the page only hides controls for
  non-admins, the backstop is server-side. Removing a member needs no
  plan-enforcement check — it only ever increases `seatsRemaining`;
  better-auth's `membershipLimit` is the live invite gate and
  decrements automatically on removal.
- `app/api/org/route.ts` — GET returning the user's orgs + roles +
  per-org plan/seats/memberCount + active org + canCreateOrg
  (read-only aggregate — LEFT JOINs `subscriptions` so Free orgs appear
  with `plan: "free"`). Creation + invites go through the better-auth
  client directly (the server-side gates enforce the plan).

## Email verification + password reset

Env-gated via `RESEND_API_KEY` (`lib/email/` — `client.ts` Resend singleton +
`EMAIL_ENABLED` flag, `templates.ts` builders). When set:
`requireEmailVerification: true`, `requireLocalEmailVerified: true`,
`sendVerificationEmail` + `sendResetPassword` callbacks via Resend,
`/verify-email` callback page, `/forgot-password` + `/reset-password` flow
pages, signup shows "check your email" screen. When unset: graceful fallback
(no verification, accounts work immediately, forgot-password link hidden).

- `sendOnSignIn: false` — verification email is NOT auto-sent on every login
  attempt (avoids spam). Instead, the login page catches the 403 "email not
  verified" error and shows a "Resend verification email" button.
- The `sendVerificationEmail` callback rewrites the callbackURL to
  `/verify-email` (Better Auth's default is `/`) so all verification emails
  land on the success page — consistent UX for both automatic signup emails
  and manual resends.
- The `/verify-email` page does NOT call `authClient.verifyEmail()` — Better
  Auth verifies the token server-side before redirecting. The page just
  checks for `?error=` param (failure) vs no error (success).
- Login + signup redirect from `useEffect`, never from render (avoids React
  warnings + a brief form flash), and use `window.location.href` (hard
  navigation) after
  successful auth to avoid client-side session hydration races.
- Password reset request calls `authClient.requestPasswordReset`
  (anti-enumeration); the reset form reads `?token=` and calls
  `authClient.resetPassword`.
- Invitations also send email when configured (`invitationEmail` template),
  gated by `sendInvitationEmail` in the organization plugin config; the
  invitee discovers the invite via the pending-invitations badge in the
  account menu otherwise.

## Future / extension points

- **Account settings page (link/unlink providers):** let signed-in users add
  password access to a social-only account, or link additional social
  providers to a password account. Better Auth supports this server-side via
  `/api/auth/link-password` and `/api/auth/link-social` — needs UI.
