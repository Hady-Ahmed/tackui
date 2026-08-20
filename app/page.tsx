import { redirect } from "next/navigation";
import { SAAS_MODE } from "@/lib/config/saas";
import { Landing } from "@/components/landing";

/**
 * Root route — SaaS-aware router.
 *
 * SaaS mode (`SAAS_MODE=true`, the hosted instance): renders the marketing
 * landing page. Authenticated users reach the chat app at `/app` (linked
 * from the landing nav).
 *
 * Self-host (`SAAS_MODE` unset, the OSS product): redirects to `/app`, where
 * the chat lives. Preserves the current single-route experience — `/` just
 * hands off to `/app`. Both `/` and `/app` work; the redirect keeps
 * bookmarks and the proxy cookie gate behaving as before (unauth → `/login`).
 */
// Force request-time rendering — SAAS_MODE is a runtime env var, so the
// landing-vs-redirect decision must be made at request time, not baked
// into the static HTML at build time (when SAAS_MODE is unset).
export const dynamic = "force-dynamic";

export default function RootPage() {
  if (SAAS_MODE) {
    return <Landing />;
  }
  redirect("/app");
}
