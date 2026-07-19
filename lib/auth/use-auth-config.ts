"use client";

import { useEffect, useState } from "react";

export interface AuthConfigUser {
  id: string;
  name: string;
  role: string;
}

export interface AuthConfig {
  emailAndPassword: boolean;
  social: string[];
  oidc: boolean;
  authDisabled: boolean;
  user: AuthConfigUser | null;
}

let cachedConfig: AuthConfig | null = null;
let inflight: Promise<AuthConfig | null> | null = null;

async function fetchConfig(): Promise<AuthConfig | null> {
  try {
    const res = await fetch("/api/auth/config");
    if (!res.ok) return null;
    return (await res.json()) as AuthConfig;
  } catch {
    return null;
  }
}

/**
 * Fetches /api/auth/config once per page load and caches the result in
 * module state. Use this to learn whether AUTH_DISABLED is set and, when
 * it is, to render the synthetic admin identity client-side — without
 * requiring a real Better Auth session.
 *
 * Components that need the session (for sign out, real user details) should
 * still use `authClient.useSession()`. This hook only answers the question
 * "am I in solo mode, and if so, who am I?". When `authDisabled` is false,
 * `user` is null and the real session should be consulted.
 */
export function useAuthConfig(): {
  config: AuthConfig | null;
  loading: boolean;
} {
  // If we already have a cached config (e.g. from a previous mount on the
  // same page), use it as the initial state — no loading flash, no fetch.
  const [config, setConfig] = useState<AuthConfig | null>(cachedConfig);
  const [loading, setLoading] = useState(!cachedConfig);

  useEffect(() => {
    if (cachedConfig) return;
    let cancelled = false;
    if (!inflight) inflight = fetchConfig();
    inflight
      .then((c) => {
        if (cancelled) return;
        if (c) cachedConfig = c;
        setConfig(c);
        setLoading(false);
      })
      .finally(() => {
        inflight = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, loading };
}
