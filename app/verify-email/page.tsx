"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";

function VerifyEmailContent() {
  const router = useRouter();
  const params = useSearchParams();
  const error = params.get("error");

  // Better Auth's verification flow: the email link goes to
  // /api/auth/verify-email?token=xxx&callbackURL=/verify-email. Better Auth
  // verifies the token server-side, then redirects to /verify-email.
  //
  // - If the redirect has no `error` param → verification succeeded.
  // - If the redirect has `?error=invalid_token` → verification failed.
  //
  // We do NOT call authClient.verifyEmail() here — Better Auth already
  // verified (or failed) before redirecting. Calling it again would try to
  // consume an already-used token and fail.
  const status: "success" | "error" = error ? "error" : "success";
  const [resendEmail, setResendEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setResending(true);
    setResendMessage(null);
    const result = await authClient.sendVerificationEmail({
      email: resendEmail,
      callbackURL: "/verify-email",
    });
    setResending(false);
    if (result.error) {
      setResendMessage(result.error.message ?? "Failed to resend verification email.");
    } else {
      setResendMessage("If an account exists, a new verification link has been sent.");
    }
  };

  if (status === "success") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
        <div className="w-full max-w-sm space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-950 dark:text-green-400">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-6 w-6" aria-hidden="true">
              <path fillRule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 8.19 5.28 6.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5Z" clipRule="evenodd" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            Email verified
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Your email address has been verified. You can now sign in.
          </p>
          <button
            onClick={() => router.push("/login")}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Continue to sign in
          </button>
        </div>
      </div>
    );
  }

  // status === "error"
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-6 w-6" aria-hidden="true">
            <path fillRule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm0-5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm.75-6.25a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0v-3.5Z" clipRule="evenodd" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Verification failed
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          The verification link is invalid or has expired. Request a new link below.
        </p>

        <form onSubmit={handleResend} className="space-y-3 text-left">
          <input
            type="email"
            value={resendEmail}
            onChange={(e) => setResendEmail(e.target.value)}
            required
            placeholder="your@email.com"
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={resending}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {resending ? "Sending..." : "Resend verification email"}
          </button>
        </form>

        {resendMessage && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{resendMessage}</p>
        )}

        <Link
          href="/login"
          className="block text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
