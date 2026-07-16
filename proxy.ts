import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

const PUBLIC_ROUTES = ["/login", "/signup"];
const AUTH_API_PREFIX = "/api/auth";

export async function proxy(request: NextRequest) {
  if (AUTH_DISABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;

  if (pathname.startsWith(AUTH_API_PREFIX) || PUBLIC_ROUTES.includes(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
