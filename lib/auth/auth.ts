import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { admin, genericOAuth } from "better-auth/plugins";
import { getPoolOrTestClient, query } from "@/lib/db/pg";

const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

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
  secret: process.env.BETTER_AUTH_SECRET || "dev-secret-change-me-in-production",
  emailAndPassword: { enabled: true },
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
          // Promote the first user to admin (bootstrap).
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
  };
}
