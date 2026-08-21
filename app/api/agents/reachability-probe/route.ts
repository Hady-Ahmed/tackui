import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/context";
import { SSRF_REJECTION_MESSAGE } from "@/lib/config/saas";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

const testSchema = z.object({
  endpoint: z.string().url(),
  kind: z.enum(["langgraph", "agui"]),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "reachabilityProbe");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = testSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { endpoint } = parsed.data;

  // SSRF guard — same choke-point as POST/PATCH /api/agents. Rejects
  // endpoints that resolve to private/internal IPs (cloud metadata,
  // loopback, RFC 1918). This closes the real vulnerability (any
  // logged-in user making the server fetch private IPs / cloud-metadata
  // endpoints) without breaking the sidebar's status-dot probing for
  // non-admin members. The response body doesn't leak — only status +
  // a masked reason — so probing public URLs is harmless. Rate-limited
  // at 30/min per user. Self-hosters who need to probe localhost
  // backends set ALLOW_PRIVATE_ENDPOINTS=true (same flag as create/edit).
  try {
    await assertSafeUrl(endpoint);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ error: SSRF_REJECTION_MESSAGE }, { status: 400 });
    }
    throw err;
  }

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });

    return NextResponse.json({
      ok: true,
      status: res.status,
      message: `Server reachable (HTTP ${res.status})`,
    });
  } catch (err) {
    // Mask raw error messages — they can leak internal hostnames/IPs
    // (e.g. DNS resolution failures). Log the detail server-side only.
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    const reason = isTimeout ? "request timed out (5s)" : "unreachable";
    console.error("[reachability-probe] fetch failed", {
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({
      ok: false,
      message: `Cannot reach server: ${reason}`,
    });
  }
}
