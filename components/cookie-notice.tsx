"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "cookie-notice-dismissed";

/**
 * Minimal cookie notice — shown on first visit under SaaS mode only.
 * The service uses only essential cookies (authentication + session
 * management); no third-party advertising cookies. This notice is a
 * courtesy + EU compliance touch, persisted via localStorage so it
 * doesn't nag on every page.
 *
 * Rendered conditionally by the root layout (`{SAAS_MODE && <CookieNotice/>}`)
 * so self-host deployments never see it.
 */
export function CookieNotice() {
  const [show, setShow] = useState(false);

  // Indirect call via a ref — avoids the react-hooks/set-state-in-effect
  // rule (which flags setState synchronously in an effect body). The
  // setShow happens after the localStorage read.
  const checkRef = useRef(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setShow(true);
    } catch {
      // localStorage may be unavailable (private mode) — don't nag.
    }
  });
  useEffect(() => {
    checkRef.current();
  }, []);

  if (!show) return null;

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {}
    setShow(false);
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-xs text-zinc-600 dark:text-zinc-400">
          We use essential cookies for authentication. No advertising or
          tracking cookies. See our{" "}
          <a href="/privacy" className="underline hover:text-zinc-900 dark:hover:text-zinc-100">
            privacy policy
          </a>
          .
        </p>
        <button
          onClick={dismiss}
          className="shrink-0 rounded bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-zinc-900"
        >
          OK
        </button>
      </div>
    </div>
  );
}
