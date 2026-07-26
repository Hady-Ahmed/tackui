import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { admin, genericOAuth, organization } from "better-auth/plugins";
import { getPoolOrTestClient, query } from "@/lib/db/pg";

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
    organization(),
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
  // init time. In auth mode the throw above guarantees a real secret.
  secret: BETTER_AUTH_SECRET ?? "solo-mode-no-sessions",
  emailAndPassword: { enabled: true },
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
      requireLocalEmailVerified: false,
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
    // When AUTH_DISABLED=true, the server treats every request as the
    // synthetic admin (see SYNTHETIC_ADMIN in lib/auth/context.ts). Expose
    // that same identity to the client via /api/auth/config so client
    // components can render the admin UI without a real session.
    user: AUTH_DISABLED
      ? { id: "local", name: "Local user", role: "admin" }
      : null,
  };
}
