import { CredentialsPage } from "@/components/credentials-page";

/**
 * The "API keys" page — the runner's BYOK credentials. Reached from the
 * account menu; the builder's inline Connect forms stay as contextual
 * shortcuts (they PUT through the same endpoint and link back here).
 */
export default function CredentialsRoute() {
  return <CredentialsPage />;
}
