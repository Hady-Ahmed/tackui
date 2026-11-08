/**
 * E2E Better Auth tables — runs the same getMigrations(auth.options) the
 * app's boot does (lib/auth/migrate.ts), but against a standalone pg Pool
 * with a minimal auth options object. The app's own auth.ts can't be
 * imported here (it pulls in email, billing, the whole graph). Instead we
 * build a minimal Better Auth config with the same database and the same
 * user/session/organization/member/invitation tables — the schema the
 * app's auth actually queries. A divergence between this schema and the
 * app's auth.ts would fail loudly at login.
 */
import { betterAuth } from "better-auth";
import { admin, organization } from "better-auth/plugins";

export async function ensureAuthTables(pool) {
  const auth = betterAuth({
    database: pool,
    emailAndPassword: { enabled: true },
    emailVerification: { sendVerificationEmail: async () => {} },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      organization({
        // Mirrors the app's auth.ts: the app also gates membershipLimit
        // via subscriptions, but for table creation the plugin shape is
        // what matters — the same tables get created.
        membershipLimit: async () => 10,
      }),
    ],
  });

  const { getMigrations } = await import("better-auth/db/migration");
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  if (toBeCreated.length > 0 || toBeAdded.length > 0) {
    await runMigrations();
  }
  return true;
}
