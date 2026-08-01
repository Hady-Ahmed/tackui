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
export default function RootPage() {
  if (SAAS_MODE) {
    return <Landing />;
  }
  redirect("/app");
}
