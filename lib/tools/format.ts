/**
 * Pure formatting helpers for tool-call rendering. No React, no DOM —
 * everything here is unit-testable in isolation.
 *
 * Used by components/tools/tool-renders.tsx to turn raw tool-call
 * parameters / results into human-friendly summaries and render hints.
 */

/** Max chars shown in the collapsed inline arg preview. */
export const PREVIEW_MAX_CHARS = 60;

/** Max chars of a value shown in an expanded key-value row. */
export const ROW_VALUE_MAX_CHARS = 400;

/** How much of the text the markdown heuristic scans. */
const MD_SCAN_CHARS = 2_000;

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

/**
 * "web_search" -> "Web search", "searchWeb" -> "Search web",
 * "GET-user" -> "Get user". First word capitalized, rest lowercase.
 */
export function humanizeToolName(name: string): string {
  if (!name) return "";
  const words = name
    .replace(/[_\-\s]+/g, " ")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return name;
  const [first, ...rest] = words;
  return [
    first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(),
    ...rest.map((w) => w.toLowerCase()),
  ].join(" ");
}

/**
 * One-line summary of the most useful argument for the collapsed row.
 * Prefers the first scalar (string/number/boolean) value; falls back to
 * the first entry. `null` when there is nothing meaningful to show.
 */
export function argPreview(parameters: unknown): string | null {
  const obj = unwrapJson(parameters);
  if (obj == null) return null;
  if (typeof obj !== "object") return truncateFlat(stringifyScalar(obj), PREVIEW_MAX_CHARS);
  if (Array.isArray(obj)) return truncateFlat(stringifyScalar(obj), PREVIEW_MAX_CHARS);

  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return null;

  const scalarEntry = entries.find(
    ([, v]) =>
      typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  const [key, value] = scalarEntry ?? entries[0];
  if (entries.length === 1 && scalarEntry) {
    return truncateFlat(stringifyScalar(value), PREVIEW_MAX_CHARS);
  }
  return truncateFlat(`${key}: ${stringifyScalar(value)}`, PREVIEW_MAX_CHARS);
}

/**
 * Flat object -> [key, displayValue] rows. Nested values become
 * pretty-printed JSON strings. Returns `null` for non-objects and
 * `[]` for empty objects (both render as the JSON fallback).
 */
export function toKeyValueRows(value: unknown): [string, string][] | null {
  const obj = unwrapJson(value);
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.map(([k, v]) => [k, formatRowValue(v)]);
}

/**
 * Pretty-printed 2-space JSON for objects/arrays; `null` for anything
 * else (scalars, circular structures).
 */
export function prettyJson(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

/** True for arrays whose every element is a plain object (table candidate). */
export function isArrayOfObjects(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) => item != null && typeof item === "object" && !Array.isArray(item),
  );
}

/**
 * Heuristic: does this string look like markdown worth rendering?
 * A code fence alone is a strong signal; otherwise 2+ distinct
 * markdown patterns (headings, bullets, bold, links, tables...).
 */
export function looksLikeMarkdown(text: string): boolean {
  const sample = text.slice(0, MD_SCAN_CHARS);
  if (/```|^~~~\s*$/m.test(sample)) return true;
  const patterns: RegExp[] = [
    /^#{1,6}\s+\S/m,
    /^\s*[-*+]\s+\S/m,
    /^\s*\d+\.\s+\S/m,
    /\*\*[^*\n]+\*\*/,
    /\[[^\]\n]+\]\([^)\n]+\)/,
    /^\|.+\|$/m,
    /^>\s+\S/m,
  ];
  let hits = 0;
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    hits += sample.match(global)?.length ?? 0;
    if (hits >= 2) return true;
  }
  return false;
}

/** Collapse all whitespace, then cap length with an ellipsis. */
export function truncateFlat(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/** Cap length without touching internal whitespace (JSON, logs). */
export function truncateRaw(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

const HAS_ESCAPE_ARTIFACTS = /\\n|\\t|\\r|\\"|\\u[0-9a-fA-F]{4}/;

/** Alternation ordered so `\\n` (escaped backslash + n) decodes to `\` + `n`,
 * never to a newline: the `\\\\` branch only matches when no shorter branch
 * fits at the position. */
const ESCAPE_SEQUENCE = /\\u([0-9a-fA-F]{4})|\\n|\\t|\\r|\\"|\\\\/g;

/**
 * Best-effort decode of JSON-escaped tool results: some backends send
 * markdown/log results as a single line with literal `\n` / `\"` /
 * `\uXXXX` sequences instead of real newlines (the result was
 * JSON-stringified upstream and never decoded).
 *
 * Conservative gate: only fires when the string has NO real newlines but
 * clearly contains escape artifacts. Real (already-decoded) content —
 * including single-line strings with no artifacts — passes through
 * untouched, so healthy output can never be mangled.
 */
export function normalizeResultString(text: string): string {
  if (text.includes("\n")) return text;
  if (!HAS_ESCAPE_ARTIFACTS.test(text)) return text;
  return text.replace(
    ESCAPE_SEQUENCE,
    (match: string, hex?: string): string => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      switch (match) {
        case "\\n":
          return "\n";
        case "\\t":
          return "\t";
        case "\\r":
          return "\r";
        case '\\"':
          return '"';
        default:
          return "\\\\" === match ? "\\" : match;
      }
    },
  );
}

function formatRowValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return truncateRaw(value, ROW_VALUE_MAX_CHARS);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateRaw(prettyJson(value) ?? String(value), ROW_VALUE_MAX_CHARS);
}

function stringifyScalar(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return `{${keys.length} key${keys.length === 1 ? "" : "s"}}`;
}

/** Parse JSON strings (only when they look like JSON) so callers can treat
 * string-encoded objects uniformly. Non-JSON strings pass through. */
function unwrapJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}
