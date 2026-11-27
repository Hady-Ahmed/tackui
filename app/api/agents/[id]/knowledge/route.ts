/**
 * Knowledge corpus routes for a builder agent — GET (list) + POST (upload)
 * on /api/agents/[id]/knowledge; DELETE on /[contentId].
 *
 * Author-only curation surface — identical to the builder PATCH/DELETE
 * semantics: authorUserId === user.id, 403 otherwise; non-builder/missing
 * rows are 404 (no existence oracle for foreign rows); no admin override.
 * A member runs the agent and retrieves the corpus through runs; only the
 * author curates it.
 *
 * tackui proxies the service's /platform/knowledge/* routes with its
 * service token, enforcing the cheap gates FIRST — clean 400s before
 * anything is forwarded (the service is the second gate, not the first):
 * format allowlist, 10 MB cap, URL shape + SSRF guard. The creator's
 * embedding key is resolved server-side from the credential store and
 * rides in the upload body ONLY — never in a response, a log line, or an
 * error detail.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { SSRF_REJECTION_MESSAGE } from "@/lib/config/saas";
import { getCredentialSecrets } from "@/lib/credentials/credential-store";
import {
  agentosErrorResponse,
  fetchKnowledgeList,
  uploadKnowledgeContent,
} from "@/lib/agents/builder";
import { ensureKnowledgeAttached, resolveCuratedAgent } from "./lifecycle";

/** Cheap request hygiene before anything is forwarded (the service
 *  enforces the same caps — this is the clean-400-first gate). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** The extensions the service ships a real reader for (agno's fallback
 *  would ingest binary noise as garbage chunks). */
const ALLOWED_EXTENSIONS = [
  ".pdf", ".csv", ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".json", ".md", ".txt",
];
const ACCEPTED_FORMATS_COPY = `Unsupported file format — accepted formats: ${ALLOWED_EXTENSIONS.join(", ")}`;

function formFile(form: FormData): File | undefined {
  const v = form.get("file");
  return v instanceof File ? v : undefined;
}

function formString(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
}

/** Optional integer form field; blank = absent, junk = the error copy. */
function parseOptionalInt(
  raw: FormDataEntryValue | null,
  label: string,
): { value?: number; error?: string } {
  if (raw === null) return {};
  if (typeof raw !== "string") return { error: `${label} must be an integer.` };
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return { error: `${label} must be an integer.` };
  return { value: n };
}

/** GET /api/agents/[id]/knowledge — the corpus's content list. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  const { id } = await params;
  const resolved = await resolveCuratedAgent(id, user.orgId, user.id);
  if ("error" in resolved) return resolved.error;

  let rows;
  try {
    rows = await fetchKnowledgeList(resolved.agent.remoteAgentId!);
  } catch (err) {
    return agentosErrorResponse(err);
  }
  return NextResponse.json(rows);
}

/** POST /api/agents/[id]/knowledge — one multipart upload (file | text |
 *  url), proxied to the service's ingest with the author's embedding key. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "knowledgeMutate");
  if (limited) return limited;

  const { id } = await params;
  const resolved = await resolveCuratedAgent(id, user.orgId, user.id);
  if ("error" in resolved) return resolved.error;
  const existing = resolved.agent;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form body" }, { status: 400 });
  }

  const file = formFile(form);
  const text = formString(form, "text");
  const urlRaw = formString(form, "url");
  const name = formString(form, "name");

  const hasFile = file !== undefined;
  const hasText = text !== undefined && text.length > 0;
  const hasUrl = urlRaw !== undefined && urlRaw.trim().length > 0;
  const sourceCount = (hasFile ? 1 : 0) + (hasText ? 1 : 0) + (hasUrl ? 1 : 0);
  if (sourceCount === 0) {
    return NextResponse.json(
      { error: "Provide a file, text, or url to upload." },
      { status: 400 },
    );
  }
  if (sourceCount > 1) {
    return NextResponse.json(
      { error: "Provide exactly ONE of file, text, or url." },
      { status: 400 },
    );
  }

  // Chunk params (file/text uploads — the service validates the same
  // shapes and applies them only where agno's readers take them).
  const chunkSizeParsed = parseOptionalInt(form.get("chunkSize"), "chunkSize");
  if (chunkSizeParsed.error) {
    return NextResponse.json({ error: chunkSizeParsed.error }, { status: 400 });
  }
  const chunkOverlapParsed = parseOptionalInt(form.get("chunkOverlap"), "chunkOverlap");
  if (chunkOverlapParsed.error) {
    return NextResponse.json({ error: chunkOverlapParsed.error }, { status: 400 });
  }
  const chunkSize = chunkSizeParsed.value;
  const chunkOverlap = chunkOverlapParsed.value;
  if (chunkSize !== undefined && chunkSize < 1) {
    return NextResponse.json({ error: "chunkSize must be at least 1." }, { status: 400 });
  }
  if (chunkOverlap !== undefined && chunkOverlap < 0) {
    return NextResponse.json({ error: "chunkOverlap must be 0 or more." }, { status: 400 });
  }
  if (chunkSize !== undefined && chunkOverlap !== undefined && chunkOverlap >= chunkSize) {
    return NextResponse.json(
      { error: "chunkOverlap must be smaller than chunkSize." },
      { status: 400 },
    );
  }

  // Per-source validation — before the credential read, before any fetch.
  if (hasFile) {
    const dot = file.name.lastIndexOf(".");
    const suffix = dot > -1 ? file.name.slice(dot).toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.includes(suffix)) {
      return NextResponse.json({ error: ACCEPTED_FORMATS_COPY }, { status: 400 });
    }
    // The parsed FormData's File carries its size — checked BEFORE
    // anything is forwarded (the parsed body is already buffered; a full
    // stream-proxy refactor is deliberately not wanted here).
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload cap.` },
        { status: 400 },
      );
    }
  } else if (hasText) {
    if (new TextEncoder().encode(text).byteLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `Text exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB request cap.` },
        { status: 400 },
      );
    }
  } else {
    const url = urlRaw!.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("scheme");
      }
    } catch {
      return NextResponse.json(
        { error: "url must be an absolute http(s) URL" },
        { status: 400 },
      );
    }
    // The SSRF guard (user-supplied URL — the gotcha applies verbatim;
    // SaaS mode hard-locks the guard on) runs BEFORE any fetch.
    try {
      await assertSafeUrl(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return NextResponse.json({ error: SSRF_REJECTION_MESSAGE }, { status: 400 });
      }
      throw err;
    }
  }

  // The embedding key — the author's own OpenAI key, resolved server-side
  // (BYOK). An author without the key cannot upload: a curation
  // prerequisite, not a run-gate matter. The key is passed to the upload
  // client only — never returned, never logged, never in an error detail.
  let embeddingKey: string | undefined;
  try {
    const secrets = await getCredentialSecrets(user.id);
    embeddingKey = secrets["openai"]?.["api_key"];
  } catch (err) {
    console.error("[knowledge] credential read failed", {
      agentId: id,
      orgId: user.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't read your saved keys — please try again." },
      { status: 500 },
    );
  }
  if (!embeddingKey) {
    return NextResponse.json(
      {
        error:
          "This agent's knowledge is embedded with your own OpenAI key — connect one in API keys and try again.",
      },
      { status: 400 },
    );
  }

  let uploaded;
  try {
    uploaded = await uploadKnowledgeContent({
      componentId: existing.remoteAgentId!,
      ...(file !== undefined
        ? { file }
        : hasText
          ? { text: text! }
          : { url: urlRaw!.trim() }),
      ...(name !== undefined && name.trim() ? { name: name.trim() } : {}),
      ...(chunkSize !== undefined ? { chunkSize } : {}),
      ...(chunkOverlap !== undefined ? { chunkOverlap } : {}),
      embeddingKey,
    });
  } catch (err) {
    return agentosErrorResponse(err);
  }

  // Attach phase — the knowledge routes are agent-mutation routes: the
  // stored config references the corpus only while ≥1 doc exists.
  let attachError: NextResponse | null;
  try {
    attachError = await ensureKnowledgeAttached(existing, user.orgId);
  } catch (err) {
    return agentosErrorResponse(err);
  }
  if (attachError) return attachError;

  return NextResponse.json(uploaded, { status: 202 });
}
