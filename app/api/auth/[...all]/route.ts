import { auth } from "@/lib/auth/auth";
import { ensureAuthTables } from "@/lib/auth/migrate";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth);

async function GET(request: Request) {
  await ensureAuthTables();
  return handlers.GET(request);
}

async function POST(request: Request) {
  await ensureAuthTables();
  return handlers.POST(request);
}

export { GET, POST };
