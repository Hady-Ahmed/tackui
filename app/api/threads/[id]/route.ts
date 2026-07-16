import { NextResponse } from "next/server";
import { z } from "zod";
import { runner } from "@/lib/agents/runner-instance";
import { getCurrentUser } from "@/lib/auth/context";

const renameSchema = z.object({
  title: z.string().min(1).max(200),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ok = runner.renameThread(id, parsed.data.title, user.id);
  if (!ok) {
    return NextResponse.json(
      { error: "Thread not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const ok = runner.deleteThread(id, user.id);
  if (!ok) {
    return NextResponse.json(
      { error: "Thread not found" },
      { status: 404 },
    );
  }
  return new NextResponse(null, { status: 204 });
}
