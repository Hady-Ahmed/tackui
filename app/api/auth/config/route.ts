import { NextResponse } from "next/server";
import { getEnabledProviders } from "@/lib/auth/auth";

export async function GET() {
  return NextResponse.json(getEnabledProviders());
}
