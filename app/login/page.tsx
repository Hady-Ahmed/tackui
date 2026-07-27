"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";

/**
 * Validates a redirect target is a same-origin relative path.
 * Prevents open-redirect attacks via `//evil.com` or `https://evil.com`
 * in the `redirect` query param. Returns `/` for anything that isn't a
 * path starting with a single `/`.
 */
function safeRedirect(value: string | null): string {
  if (!value) return "/";
  // Must start with a single slash, not `//` (protocol-relative) or `/\`
  // (some browsers treat `/\` as a protocol separator on Windows).
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  if (value.startsWith("/\\")) return "/";
  return value;
}

function LoginContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const { config } = useAuthConfig();

  const redirect = safeRedirect(params.get("redirect"));

  useEffect(() => {
    if (config?.authDisabled) {
      router.push(redirect);
    }
  }, [config?.authDisabled, redirect, router]);

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNeedsVerification(false);
    const result = await authClient.signIn.email({ email, password });
    setLoading(false);
    if (result.error) {
      // Better Auth returns 403 when email verification is required
      // but the user's email is not verified. Show a targeted message
      // with a resend button instead of the generic error.
      if (result.error.status === 403) {
        setNeedsVerification(true);
      } else {
        setError(result.error.message ?? "Sign in failed");
      }
    } else {
      // Hard navigation — avoids client-side hydration race where the
      // target page doesn't see the new session yet and redirects back
      // to /login. A full page load sends the new session cookie.
      window.location.href = redirect;
    }
  };

  const handleResendVerification = async () => {
    setResending(true);
    setResendMessage(null);
    const result = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/verify-email",
    });
    setResending(false);
    if (result.error) {
      setResendMessage("Failed to resend. Please try signing up again.");
    } else {
      setResendMessage("Verification email sent. Check your inbox.");
    }
  };

  const handleSocial = async (provider: string) => {
    setError(null);
    await authClient.signIn.social({
      provider,
      callbackURL: redirect,
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Sign in
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            AG-UI Chat — unified agent frontend
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        {needsVerification && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            <p className="mb-2">
              Please verify your email address before signing in.
            </p>
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={resending}
              className="font-medium text-amber-900 underline hover:no-underline disabled:opacity-50 dark:text-amber-200"
            >
              {resending ? "Sending..." : "Resend verification email"}
            </button>
            {resendMessage && (
              <p className="mt-2 text-xs">{resendMessage}</p>
            )}
          </div>
        )}

        {config && config.social.length > 0 && (
          <div className="space-y-2">
            {config.social.includes("google") && (
              <SocialButton onClick={() => handleSocial("google")} label="Continue with Google" />
            )}
            {config.social.includes("github") && (
              <SocialButton onClick={() => handleSocial("github")} label="Continue with GitHub" />
            )}
            {config.oidc && (
              <SocialButton onClick={() => handleSocial("oidc")} label="Continue with SSO" />
            )}
            {config.emailAndPassword && (
              <div className="relative py-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-zinc-200 dark:border-zinc-800" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-zinc-50 px-2 text-xs text-zinc-400 dark:bg-black">
                    or
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {config?.emailAndPassword && (
          <form onSubmit={handleEmailSignIn} className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Email"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Password"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            {config?.emailVerification && (
              <div className="text-right">
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Forgot password?
                </Link>
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

function SocialButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {label}
    </button>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
