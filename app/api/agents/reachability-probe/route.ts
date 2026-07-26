import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

const testSchema = z.object({
  endpoint: z.string().url(),
  kind: z.enum(["langgraph", "agno", "agui"]),
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
