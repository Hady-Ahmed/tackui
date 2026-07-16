import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { admin, genericOAuth } from "better-auth/plugins";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.AGENT_DB_PATH || "./data/agent-state.db";
const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

if (DB_PATH !== ":memory:") {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

export const authDb = new Database(DB_PATH);
authDb.pragma("journal_mode = WAL");

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
  database: authDb,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET || "dev-secret-change-me-in-production",
  emailAndPassword: { enabled: true },
  socialProviders: buildSocialProviders(),
  plugins: buildPlugins(),
  databaseHooks: {
    user: {
      create: {
        async after(user) {
          const row = authDb
            .prepare("SELECT COUNT(*) as count FROM user")
            .get() as { count: number };
          if (row.count === 1) {
            authDb
              .prepare("UPDATE user SET role = ? WHERE id = ?")
              .run("admin", user.id);
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
