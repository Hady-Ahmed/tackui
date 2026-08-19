import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { admin, genericOAuth, organization } from "better-auth/plugins";
import { getPoolOrTestClient, query } from "@/lib/db/pg";
import { EMAIL_ENABLED, sendEmail } from "@/lib/email/client";
import { verificationEmail, passwordResetEmail, invitationEmail } from "@/lib/email/templates";
import { getMembershipLimit } from "@/lib/billing/subscription-store";

const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

// Enforce a real secret when auth is enabled. A missing secret in auth
// mode would silently fall back to a publicly-known value (in the source),
// allowing session-cookie forgery. Solo mode (AUTH_DISABLED=true) doesn't
// sign sessions, so it's exempt.
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
if (!AUTH_DISABLED && !BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET is required when AUTH_DISABLED is not 'true'. " +
      "Generate one with: openssl rand -hex 32",
  );
}
// Defensive: the fallback "solo-mode-no-sessions" is only reachable when
// AUTH_DISABLED=true (the boot throw above guarantees BETTER_AUTH_SECRET
// is set in auth mode). Expressing this explicitly here means a future
// refactor that removes the throw can't silently reintroduce a
// publicly-known signing secret in auth mode — the fallback branch is
// unreachable by construction when AUTH_DISABLED is false.
const AUTH_SECRET: string = AUTH_DISABLED
  ? "solo-mode-no-sessions"
  : (BETTER_AUTH_SECRET as string);

function buildSocialProviders() {
  const providers: Record<
    string,
    { clientId: string; clientSecret: string }
  > = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }
  return providers;
}

function buildPlugins(): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    organization({
      // SaaS plan enforcement, wired server-side so it can't be bypassed
      // by a direct API call. Self-host: both return unlimited/true.
      //
      // allowUserToCreateOrganization — always true. Creating workspaces
      // is free and unrestricted (Vercel/GitHub model): a Free workspace
      // has 3 agents max, 1 member, no invites — harmless. The Team plan
      // gates *invites* (via membershipLimit below), not workspace
      // creation. The personal org auto-created on signup goes through
      // the session hook, NOT this gate.
      allowUserToCreateOrganization: async () => true,
      // membershipLimit — per-org seat cap. free/pro = 1 (personal, no
      // invites), team = subscription.seats. better-auth rejects invites
      // past this with ORGANIZATION_MEMBERSHIP_LIMIT_REACHED.
      membershipLimit: async (_user, org) => {
        if (!org?.id) return 1;
        return getMembershipLimit(org.id);
      },
      // sendInvitationEmail — fires when a user invites someone by email.
      // Env-gated: when SMTP is configured (RESEND_API_KEY set), the
      // invitee gets an email with an accept link. When unset, no email
      // is sent — the invitee discovers the invitation via the pending-
      // invitations badge in the account menu (or by visiting /app/
      // invitations directly).
      sendInvitationEmail: EMAIL_ENABLED
        ? async (data) => {
            const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
            const acceptUrl = `${baseUrl}/app/invitations`;
            const orgName = data.organization?.name ?? "a workspace";
            const inviterName =
              data.inviter?.user?.name ?? data.inviter?.user?.email ?? "Someone";
            void sendEmail(
              data.email,
              invitationEmail({
                email: data.email,
                organizationName: orgName,
                inviterName,
                acceptUrl,
              }),
            );
          }
        : undefined,
    }),
  ];

  if (
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET &&
    process.env.OIDC_ISSUER
  ) {
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: "oidc",
            clientId: process.env.OIDC_CLIENT_ID,
            clientSecret: process.env.OIDC_CLIENT_SECRET,
            discoveryUrl: `${process.env.OIDC_ISSUER}/.well-known/openid-configuration`,
            scopes: ["openid", "email", "profile"],
          },
        ],
      }),
    );
  }

  return plugins;
}

export const auth = betterAuth({
  database: getPoolOrTestClient(),
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  // In solo mode (AUTH_DISABLED=true) no sessions are signed, so the
  // secret value is irrelevant — Better Auth still needs a string at
  // init time. In auth mode the boot throw + the AUTH_SECRET const
  // above guarantee a real, env-supplied secret.
  secret: AUTH_SECRET,
  // Pin cookie security flags explicitly. Better Auth's defaults are
  // httpOnly:true + sameSite:"lax" + secure:"auto" (true only when
  // NODE_ENV === "production" AND the request looks like HTTPS). Behind
  // a TLS-terminating proxy that doesn't forward X-Forwarded-Proto,
  // "auto" can mark cookies non-secure. Pinning `secure` to production
  // makes the attribute a function of the deployment environment, not
  // of how the proxy forwards headers.
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
    },
  },
  emailAndPassword: {
    enabled: true,
    // Require email verification before sign-in when SMTP is configured.
    // When SMTP is not configured (self-hosters without Resend), this is
    // false — accounts work immediately without verification.
    requireEmailVerification: EMAIL_ENABLED,
    // Send password reset email when SMTP is configured.
    sendResetPassword: EMAIL_ENABLED
      ? async ({ user, url }) => {
          void sendEmail(user.email, passwordResetEmail(user, url));
        }
      : undefined,
  },
  // Email verification — only enabled when SMTP is configured.
  // sendOnSignIn is false: we don't auto-send on every login attempt
  // (that would be spammy). Instead, the login page catches the 403
  // "email not verified" error and shows a "Resend verification email"
  // button the user can click explicitly.
  emailVerification: EMAIL_ENABLED
    ? {
        sendVerificationEmail: async ({ user, url }) => {
          // Rewrite the callbackURL so all verification emails (both
          // the automatic signup one and manual resends) redirect to
          // /verify-email instead of the default /. This gives a
          // consistent UX — the user always sees the "Email verified"
          // success page, not a bare redirect to the login page.
          // Using URL parse + setSearchParam (not string replace) to
          // be idempotent — setting the same value twice is a no-op.
          const parsed = new URL(url);
          parsed.searchParams.set("callbackURL", "/verify-email");
          void sendEmail(user.email, verificationEmail(user, parsed.toString()));
        },
        sendOnSignIn: false,
      }
    : undefined,
  // Explicit rate limiting — replaces the silent default. Per-IP (no user
  // exists pre-login). In-memory storage (single-instance; for multi-
  // instance, switch to a Redis-backed custom storage).
  rateLimit: {
    enabled: !AUTH_DISABLED,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
  socialProviders: buildSocialProviders(),
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github", "oidc"],
      // Require local email verification before auto-linking a social
      // account to an existing email/password account. Prevents
      // account-takeover via email pre-enumeration. When SMTP is not
      // configured, this is false (graceful fallback — trustedProviders
      // mitigates the risk).
      requireLocalEmailVerified: EMAIL_ENABLED,
    },
  },
  plugins: buildPlugins(),
  databaseHooks: {
    user: {
      create: {
        async after(user) {
          // First-user-is-admin bootstrap only.
          // Org + member creation moved to session.create.before — see
          // the comment there for why (Better Auth defers user.create.after
          // to post-transaction, so the member row isn't available when
          // session.create.before fires).
          // "user" is a reserved word in Postgres and must be double-quoted.
          const row = await query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM "user"`,
          );
          if ((row.rows[0]?.count ?? 0) === 1) {
            await query(
              `UPDATE "user" SET role = $1 WHERE id = $2`,
              ["admin", user.id],
            );
          }
        },
      },
    },
    session: {
      create: {
        async before(session) {
          // Auto-set activeOrganizationId on new sessions by looking up
          // the user's personal org (their owner membership).
          //
          // If the membership doesn't exist yet (first signup — the
          // user.create.after hook is deferred to post-transaction by
          // Better Auth, so it hasn't run yet), create the org + member
          // rows right here in-transaction. This ensures every auth path
          // (email signup, email login, social signup, social login, OIDC
          // SSO) gets a correct activeOrganizationId on the session.
          const memberRow = await query<{
            "organizationId": string;
          }>(
            `SELECT "organizationId" FROM member
             WHERE "userId" = $1 AND role = 'owner'
             ORDER BY "createdAt" ASC LIMIT 1`,
            [session.userId],
          );

          let orgId = memberRow.rows[0]?.organizationId ?? null;

          if (!orgId) {
            // First signup: user.create.after hasn't run yet (deferred
            // to post-transaction). Create the personal org + owner
            // membership now, in-transaction, so the session row gets
            // a valid activeOrganizationId.
            const { randomUUID } = await import("node:crypto");
            orgId = randomUUID();

            const userRow = await query<{ name: string | null; email: string | null }>(
              `SELECT name, email FROM "user" WHERE id = $1`,
              [session.userId],
            );
            const userName =
              userRow.rows[0]?.name ?? userRow.rows[0]?.email ?? "My";
            const orgName = `${userName}'s workspace`;
            const slug = `personal-${session.userId.slice(0, 8)}`;

            await query(
              `INSERT INTO organization (id, name, slug, "createdAt")
               VALUES ($1, $2, $3, now())`,
              [orgId, orgName, slug],
            );
            await query(
              `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
               VALUES ($1, $2, $3, $4, now())`,
              [randomUUID(), orgId, session.userId, "owner"],
            );
          }

          return {
            data: {
              ...session,
              activeOrganizationId: orgId,
            },
          };
        },
      },
    },
  },
});

export function isAuthDisabled(): boolean {
  return AUTH_DISABLED;
}

export function getEnabledProviders() {
  return {
    emailAndPassword: true,
    social: Object.keys(buildSocialProviders()),
    oidc:
      !!process.env.OIDC_CLIENT_ID &&
      !!process.env.OIDC_CLIENT_SECRET &&
      !!process.env.OIDC_ISSUER,
    authDisabled: AUTH_DISABLED,
    // Expose whether email verification + password reset are available.
    // The client uses this to show "verify your email" prompts and
    // "Forgot password?" links.
    emailVerification: EMAIL_ENABLED,
    // When AUTH_DISABLED=true, the server treats every request as the
    // synthetic admin (see SYNTHETIC_ADMIN in lib/auth/context.ts). Expose
    // that same identity to the client via /api/auth/config so client
    // components can render the admin UI without a real session.
    user: AUTH_DISABLED
      ? { id: "local", name: "Local user", role: "admin" }
      : null,
  };
}
