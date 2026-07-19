import { auth } from "../lib/auth/auth";
import { query, closePool } from "../lib/db/pg";

const email = process.argv[2];
const password = process.argv[3];
const name = process.argv[4] || "Admin";

if (!email || !password) {
  console.error("Usage: npm run create-admin <email> <password> [name]");
  console.error("Example: npm run create-admin admin@example.com mypassword123");
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

async function main() {
  try {
    await auth.api.signUpEmail({
      body: { email, password, name },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("already")) {
      console.log(`User ${email} already exists — updating role to admin.`);
    } else {
      throw err;
    }
  }

  // "user" is a reserved word in Postgres and must be double-quoted.
  await query(
    `UPDATE "user" SET role = $1 WHERE email = $2`,
    ["admin", email],
  );

  console.log(`Admin user ready: ${email}`);
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
