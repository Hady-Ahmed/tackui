/**
 * Client-safe platform-catalog helpers — the Models & tools page's pure
 * logic (components/platform-admin.tsx is "use client", so the derivation
 * it renders lives here where vitest can exercise it, mirroring the
 * builder-config.ts pattern).
 *
 * The domain is MODEL PROVIDERS only. Toolkits have no model-id lists —
 * their checkbox is a genuine independent choice and stays in the
 * component (ToolRow); nothing in this module reads or emits a toolkit
 * field.
 *
 * The one fact this module encodes: a provider is enabled exactly when it
 * lists at least one model id. The two historical save-time guards
 * (AgentOS: "enabled but lists no model ids" → 400, and "disabled — its
 * model ids were ignored" → skipped) forbid the same diagonal — the
 * checkbox and the id list were never two inputs. The draft now stores
 * only the model rows and derives enabled from them, so neither forbidden
 * state can be constructed in the page, let alone sent. The AgentOS keeps
 * its own guards as defense-in-depth: a rogue API call still can't write
 * one.
 */

/** Non-empty, trimmed model entries — what save() sends and what counts
    toward "has models". Blank in-progress rows are not ids. */
export function savedEntries(models: string[]): string[] {
  return models.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** Serialize a saved model row back to its grammar entry (row prefill). */
export function modelEntryText(row: {
  id: string;
  attrs: Record<string, unknown>;
  tier: boolean;
}): string {
  const parts = [row.id];
  if (row.tier) parts.push("tier");
  for (const [key, value] of Object.entries(row.attrs)) {
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(":");
}

/** The derived fact: enabled ⟺ the provider lists at least one (non-empty)
    model id. Adding the first id lights a provider; removing the last one
    dims it — automatically, in the draft. */
export function deriveProviderEnabled(models: string[]): boolean {
  return savedEntries(models).length > 0;
}

/** The provider row's status indicator — what the header renders where the
    checkbox used to sit. Not an input: the dot fills when ids exist and
    goes hollow/off when none do, and the state rides the glyph SHAPE and
    the label TEXT (not just color) so it survives colorblindness and dark
    themes. */
export interface ProviderStatus {
  enabled: boolean;
  /** Filled when enabled, hollow when not. */
  glyph: "●" | "○";
  /** "3 models" / "1 model" when enabled; "off" when not. */
  label: string;
}

export function providerStatus(models: string[]): ProviderStatus {
  const count = savedEntries(models).length;
  const enabled = count > 0;
  return {
    enabled,
    glyph: enabled ? "●" : "○",
    label: enabled ? `${count} ${count === 1 ? "model" : "models"}` : "off",
  };
}

/** One entry of the PUT body. `enabled` is DERIVED here, never passed —
    the caller cannot construct the forbidden states ("enabled with no
    ids", the blocked-save case, or "ids under a disabled provider", the
    ignored-ids case) through this shape. */
export function providerPutEntry(
  slug: string,
  models: string[],
): { slug: string; enabled: boolean; models: string[] } {
  const entries = savedEntries(models);
  return { slug, enabled: deriveProviderEnabled(entries), models: entries };
}
