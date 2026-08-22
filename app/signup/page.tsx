"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";

interface AuthConfig {
  emailAndPassword: boolean;
  social: string[];
  oidc: boolean;
  authDisabled: boolean;
  emailVerification: boolean;
}

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [showVerifyPrompt, setShowVerifyPrompt] = useState(false);

  useEffect(() => {
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
  }, []);

  const handleEmailSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await authClient.signUp.email({ name, email, password });
    setLoading(false);
    if (result.error) {
      setError(result.error.message ?? "Sign up failed");
    } else if (config?.emailVerification) {
      // Better Auth automatically sends a verification email during signup
      // (when requireEmailVerification + sendVerificationEmail are configured).
      // We don't call sendVerificationEmail explicitly — that would send a
      // duplicate. For account-linking edge cases (Google account already
      // exists), the user discovers verification is needed when they try to
      // log in → 403 → "Resend verification email" button on the login page.
      setShowVerifyPrompt(true);
    } else {
      // Hard navigation — avoids client-side hydration race.
      window.location.href = "/app";
    }
  };

  const handleSocial = async (provider: string) => {
    setError(null);
    await authClient.signIn.social({ provider, callbackURL: "/app" });
  };

  useEffect(() => {
    if (config?.authDisabled) {
      router.push("/app");
    }
  }, [config?.authDisabled, router]);

  if (showVerifyPrompt) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
        <div className="w-full max-w-sm space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-6 w-6" aria-hidden="true">
              <path d="M2.5 3.75A.75.75 0 0 1 3.25 3h9.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-9.5a.75.75 0 0 1-.75-.75v-8.5ZM3.25 2A1.75 1.75 0 0 0 1.5 3.75v8.5c0 .966.784 1.75 1.75 1.75h9.5A1.75 1.75 0 0 0 14.5 12.25v-8.5A1.75 1.75 0 0 0 12.75 2h-9.5Z" />
              <path d="M4 4.75A.75.75 0 0 1 4.75 4h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 4.75ZM4 7a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 7Z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            Check your email
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            We sent a verification link to <strong>{email}</strong>.
            Click the link to verify your email and activate your account.
          </p>
          <p className="text-xs text-zinc-400">
            Didn&apos;t receive an email? Check your spam folder, or
            {" "}
            <Link href="/login" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
              try signing in
            </Link>
            {" "}to resend the verification email.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Create account
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            TackUI — unified agent frontend
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
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
          <form onSubmit={handleEmailSignUp} className="space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Name"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
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
              minLength={8}
              placeholder="Password (min 8 characters)"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Sign in
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
