import { describe, expect, it } from "vitest";
import {
  deriveProviderEnabled,
  modelEntryText,
  providerPutEntry,
  providerStatus,
  savedEntries,
} from "./platform-admin-catalog";

describe("savedEntries", () => {
  it("trims entries and drops blank rows", () => {
    expect(savedEntries([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("returns an empty list for an empty or all-blank draft", () => {
    expect(savedEntries([])).toEqual([]);
    expect(savedEntries(["", "   "])).toEqual([]);
  });
});

describe("modelEntryText — row prefill", () => {
  it("serializes a bare id", () => {
    expect(modelEntryText({ id: "gpt-4o", attrs: {}, tier: false })).toBe("gpt-4o");
  });

  it("serializes the dormant tier segment", () => {
    expect(modelEntryText({ id: "gpt-4o", attrs: {}, tier: true })).toBe("gpt-4o:tier");
  });

  it("appends attributes after the id (tier first)", () => {
    expect(
      modelEntryText({ id: "m", attrs: { max_tokens: 8192, name: "Fast" }, tier: true }),
    ).toBe("m:tier:max_tokens=8192:name=Fast");
  });
});

describe("deriveProviderEnabled — the derived fact", () => {
  it("adding the first model id marks the provider enabled", () => {
    // The draft journey: expand a provider that is off, "+ Add model id",
    // type an id — the dot lights with no separate toggle anywhere.
    const rows: string[] = [];
    expect(deriveProviderEnabled(rows)).toBe(false);
    rows.push("gpt-6-luna");
    expect(deriveProviderEnabled(rows)).toBe(true);
  });

  it("removing the last model id marks it disabled", () => {
    const rows = ["gpt-6-luna", "gpt-6"];
    expect(deriveProviderEnabled(rows)).toBe(true);
    rows.splice(1, 1);
    expect(deriveProviderEnabled(rows)).toBe(true);
    rows.splice(0, 1);
    expect(deriveProviderEnabled(rows)).toBe(false);
  });

  it("blank in-progress rows are not ids — they neither enable nor keep enabled", () => {
    // An uncommitted empty row ("+ Add model id" with nothing typed) is
    // not a model: the provider stays off until a real id exists.
    expect(deriveProviderEnabled([""])).toBe(false);
    expect(deriveProviderEnabled(["   "])).toBe(false);
    // A blank row beside a real id is irrelevant — the id decides.
    expect(deriveProviderEnabled(["gpt-4o", ""])).toBe(true);
  });

  it("toolkit independence — the helper domain is model rows only", () => {
    // Toolkits are toggled by a real checkbox in the component (a genuine
    // independent choice); the derivation reads nothing but the model
    // rows — one argument, and no toolkit notion exists in this module.
    expect(deriveProviderEnabled.length).toBe(1);
    expect(deriveProviderEnabled(["anything"])).toBe(true);
    expect(deriveProviderEnabled([])).toBe(false);
  });
});

describe("providerStatus — the header indicator", () => {
  it("reads enabled with the filled glyph and the model count", () => {
    expect(providerStatus(["a", "b", "c"])).toEqual({
      enabled: true,
      glyph: "●",
      label: "3 models",
    });
    expect(providerStatus(["a"]).label).toBe("1 model");
  });

  it("reads off with the hollow glyph when no ids exist", () => {
    expect(providerStatus([])).toEqual({ enabled: false, glyph: "○", label: "off" });
    // Blank in-progress rows alone are still "off".
    expect(providerStatus(["", "  "])).toEqual({ enabled: false, glyph: "○", label: "off" });
  });

  it("carries the state in the glyph shape and the label text, not just color", () => {
    // Colorblind users and dark themes must still read the state: the
    // filled/hollow shapes differ and the labels are different words.
    const on = providerStatus(["a"]);
    const off = providerStatus([]);
    expect(on.glyph).not.toBe(off.glyph);
    expect(on.label).not.toBe(off.label);
  });
});

describe("providerPutEntry — the PUT body encodes the derived state", () => {
  it("the invariant holds for every draft shape: enabled ⟺ models.length > 0", () => {
    for (const models of [[], [""], ["   "], ["gpt-4o"], ["gpt-4o", ""], ["  o3  "]]) {
      const entry = providerPutEntry("openai-responses", models);
      expect(entry.enabled).toBe(entry.models.length > 0);
    }
  });

  it("cannot produce the blocked-save state — an enabled provider with no ids", () => {
    // "Add at least one model id — an enabled provider with no models
    // shows nothing in the picker." Unrepresentable: no ids → not enabled.
    expect(providerPutEntry("x", [])).toEqual({ slug: "x", enabled: false, models: [] });
    expect(providerPutEntry("x", ["", " "])).toEqual({ slug: "x", enabled: false, models: [] });
  });

  it("cannot produce the ignored-ids state — ids under a disabled provider", () => {
    // "provider 'X' is disabled — its model ids were ignored."
    // Unrepresentable: ids present → enabled, so they are never ignored.
    expect(providerPutEntry("x", ["gpt-4o"])).toEqual({
      slug: "x",
      enabled: true,
      models: ["gpt-4o"],
    });
  });

  it("sends trimmed, non-empty entries and carries the slug through", () => {
    expect(providerPutEntry(" openai-responses ", ["  gpt-4o ", "", "o3"])).toEqual({
      slug: " openai-responses ",
      enabled: true,
      models: ["gpt-4o", "o3"],
    });
  });

  it("toolkit independence — a PUT entry is provider fields only", () => {
    // The tools half of the PUT body is built separately in the component
    // from the real toolkit checkboxes; a provider entry carries no
    // toolkit field at all.
    expect(Object.keys(providerPutEntry("x", ["m"]))).toEqual(["slug", "enabled", "models"]);
  });
});

describe("clear-all semantics — through the derived layer", () => {
  it("clearing every row (saved ids and in-progress blanks alike) saves the provider disabled", () => {
    // The draft keeps ONE list per provider: the rows prefilled from the
    // catalog (the "saved" ids) and any uncommitted in-progress blanks
    // are the same array, so the component's clear-all — replacing the
    // list wholesale — necessarily drops both. These assertions pin the
    // downstream consequences the spec cares about.
    const draftRows = ["gpt-4o", "", "o3-mini"]; // saved ids + an in-progress blank
    expect(providerStatus(draftRows).enabled).toBe(true);

    const cleared: string[] = []; // the component's clear-all: () => []
    expect(providerStatus(cleared)).toEqual({ enabled: false, glyph: "○", label: "off" });
    expect(providerPutEntry("openai-responses", cleared)).toEqual({
      slug: "openai-responses",
      enabled: false,
      models: [],
    });
  });

  it("clear-all is offered exactly when there is something to clear", () => {
    // The button's visibility rides the same derivation as the dot —
    // no dead affordance on an empty (or blanks-only) list.
    expect(providerStatus([]).enabled).toBe(false);
    expect(providerStatus([""]).enabled).toBe(false);
    expect(providerStatus(["gpt-4o"]).enabled).toBe(true);
  });
});
