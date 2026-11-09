/**
 * E2E seed — the disposable fixtures every smoke test depends on:
 *   1. A verified admin user (email/password login) — the platform admin
 *      role, so the /admin surface canaries render.
 *   2. The mock AG-UI agent — a manual agent whose endpoint points at the
 *      mock AG-UI server (127.0.0.1, started by web-server.mjs). The chat
 *      smoke test selects it and sends a message; the run path (CopilotKit
 *      runtime → SSE → registry) is real, only the model is fake.
 *
 * Rows are inserted with the same stores the app uses (the store's SQL, or
 * the auth API for the user — Better Auth's signup path hashes the
 * password exactly as the app's login expects). The admin user is created
 * via auth.api.signUpEmail + the same role/verified SQL updates
 * scripts/create-admin.ts uses — so the login flow is the real one.
 */
import { randomUUID } from "node:crypto";

export const E2E_ADMIN_EMAIL = "e2e-admin@test.local";
export const E2E_ADMIN_PASSWORD = "e2e-admin-password";
// The second seeded user — the orgs/invitations spec's invitee (2C, #103).
// A regular verified user: NOT promoted to admin, no personal org
// pre-created (the app's session hook creates it on the first real login,
// which is the journey under test). Shared fixture by definition — other
// specs must only ever read it (they never touch it at all today).
export const E2E_MEMBER_EMAIL = "e2e-member@test.local";
export const E2E_MEMBER_PASSWORD = "e2e-member-password";

export async function seed(pool, {
  adminEmail,
  adminPassword,
  memberEmail = E2E_MEMBER_EMAIL,
  memberPassword = E2E_MEMBER_PASSWORD,
  mockAgentUrl,
  mockAgentJwtSecret,
}) {
  const auth = (await import("better-auth")).betterAuth({
    database: pool,
    emailAndPassword: { enabled: true },
    emailVerification: { sendVerificationEmail: async () => {} },
    // The session hook is where the personal org gets created on the
    // app's boot (lib/auth/auth.ts) — but the hook only fires on session
    // creation, which happens at login (the app's process, not here).
    // The seed creates the personal org + owner membership directly, so
    // the app's login finds the org without needing the hook first.
    // The session hook's own org creation is skipped (orgId resolves
    // from the membership lookup) — the same rows the app's hook would
    // create, so the app path is the real one.
    databaseHooks: {
      session: {
        create: {
          async before(session) {
            const memberRow = await pool.query(
              `SELECT "organizationId" FROM member
               WHERE "userId" = $1 AND role = 'owner'
               ORDER BY "createdAt" ASC LIMIT 1`,
              [session.userId],
            );
            const orgId = memberRow.rows[0]?.organizationId ?? null;
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

  // 1. Admin user — the real signup path (password hashing matches the
  //    app's login), then the same role/verified updates create-admin.ts
  //    applies. Idempotent: re-seeding an existing DB updates in place.
  try {
    await auth.api.signUpEmail({
      body: { email: adminEmail, password: adminPassword, name: "E2E Admin" },
    });
  } catch (err) {
    if (!String(err?.message).includes("already")) throw err;
  }
  await pool.query(`UPDATE "user" SET role = 'admin' WHERE email = $1`, [adminEmail]);
  await pool.query(`UPDATE "user" SET "emailVerified" = TRUE WHERE email = $1`, [adminEmail]);

  // 2. The personal org + owner membership — the rows the app's session
  //    hook (lib/auth/auth.ts) would create on the first login. The
  //    session hook runs at login (in the app's process), so the seed
  //    creates them directly: the org slug matches the app's naming
  //    (`personal-<userId.slice(0,8)>`), and the agent's org_id is the
  //    org the session's activeOrganizationId resolves to.
  const userRow = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [adminEmail]);
  const userId = userRow.rows[0]?.id;
  if (!userId) throw new Error("seed admin user not found after signup");

  const existingMember = await pool.query(
    `SELECT "organizationId" FROM member WHERE "userId" = $1 AND role = 'owner' LIMIT 1`,
    [userId],
  );
  let orgId = existingMember.rows[0]?.organizationId;
  if (!orgId) {
    orgId = randomUUID();
    await pool.query(
      `INSERT INTO organization (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now())`,
      [orgId, "E2E Admin's workspace", `personal-${userId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now())`,
      [randomUUID(), orgId, userId],
    );
  }

  // 3. The second user — same creation path as the admin (real signup +
  //    verified email via SQL), but a plain user: no role update, no
  //    personal org here. The app's session hook (lib/auth/auth.ts)
  //    creates the personal org on the user's first login in the app's
  //    process — exactly the multi-user journey the orgs spec drives.
  //    Idempotent like the admin's signup.
  try {
    await auth.api.signUpEmail({
      body: { email: memberEmail, password: memberPassword, name: "E2E Member" },
    });
  } catch (err) {
    if (!String(err?.message).includes("already")) throw err;
  }
  await pool.query(`UPDATE "user" SET "emailVerified" = TRUE WHERE email = $1`, [memberEmail]);

  const agentCount = await pool.query(`SELECT count(*)::int AS n FROM agents`);
  const agentId = "e2e-mock-agent";
  await pool.query(
    `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes, origin, author_user_id, remote_agent_id, requirements)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'manual', NULL, NULL, NULL)
     ON CONFLICT (id, org_id) DO UPDATE SET
       endpoint = EXCLUDED.endpoint,
       jwt_secret = EXCLUDED.jwt_secret,
       name = EXCLUDED.name`,
    [
      agentId,
      "E2E Mock Agent",
      "Deterministic AG-UI backend for smoke tests — replies with a fixed message.",
      mockAgentUrl,
      orgId,
      "jwt",
      mockAgentJwtSecret,
    ],
  );

  return {
    adminEmail,
    adminPassword,
    memberEmail,
    memberPassword,
    orgId,
    agents: [
      {
        id: agentId,
        name: "E2E Mock Agent",
        existedBefore: agentCount.rows[0]?.n > 0,
      },
    ],
  };
}
