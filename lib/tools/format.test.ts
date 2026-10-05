import { describe, it, expect } from "vitest";
import {
  humanizeToolName,
  argPreview,
  toKeyValueRows,
  prettyJson,
  isArrayOfObjects,
  looksLikeMarkdown,
  normalizeResultString,
  truncateFlat,
  truncateRaw,
  PREVIEW_MAX_CHARS,
  ROW_VALUE_MAX_CHARS,
} from "./format";

describe("humanizeToolName", () => {
  it("splits snake_case into title + lowercase", () => {
    expect(humanizeToolName("web_search")).toBe("Web search");
  });

  it("splits kebab-case and camelCase", () => {
    expect(humanizeToolName("fetch-user-data")).toBe("Fetch user data");
    expect(humanizeToolName("searchWeb")).toBe("Search web");
  });

  it("leaves already-spaced names readable", () => {
    expect(humanizeToolName("Run Query")).toBe("Run query");
  });

  it("returns empty string for empty input", () => {
    expect(humanizeToolName("")).toBe("");
  });

  it("handles single word", () => {
    expect(humanizeToolName("search")).toBe("Search");
  });
});

describe("argPreview", () => {
  it("returns null for null/undefined/empty", () => {
    expect(argPreview(null)).toBeNull();
    expect(argPreview(undefined)).toBeNull();
    expect(argPreview({})).toBeNull();
  });

  it("shows the single scalar value without key prefix", () => {
    expect(argPreview({ query: "weather in paris" })).toBe("weather in paris");
    expect(argPreview({ limit: 10 })).toBe("10");
  });

  it("prefixes key when there are multiple args", () => {
    expect(argPreview({ query: "cats", limit: 5 })).toBe("query: cats");
  });

  it("prefers the first scalar over objects", () => {
    expect(argPreview({ options: { a: 1 }, query: "x" })).toBe("query: x");
  });

  it("falls back to first entry when no scalar exists", () => {
    expect(argPreview({ options: { a: 1 }, extra: [1] })).toBe(
      "options: {1 key}",
    );
  });

  it("summarizes arrays and objects compactly", () => {
    expect(argPreview({ ids: [1, 2, 3] })).toBe("ids: [3 items]");
  });

  it("parses JSON-string parameters", () => {
    expect(argPreview('{"query":"hi"}')).toBe("hi");
  });

  it("handles non-JSON string parameters", () => {
    expect(argPreview("plain text")).toBe("plain text");
  });

  it("truncates long values", () => {
    const long = "a".repeat(200);
    const out = argPreview({ query: long })!;
    expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses newlines in the preview", () => {
    expect(argPreview({ query: "line1\nline2" })).toBe("line1 line2");
  });
});

describe("toKeyValueRows", () => {
  it("returns rows for flat objects", () => {
    expect(toKeyValueRows({ a: 1, b: true, c: "x" })).toEqual([
      ["a", "1"],
      ["b", "true"],
      ["c", "x"],
    ]);
  });

  it("pretty-prints nested values as JSON strings", () => {
    const rows = toKeyValueRows({ meta: { page: 2 } })!;
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("meta");
    expect(JSON.parse(rows[0][1])).toEqual({ page: 2 });
  });

  it("returns null for non-objects", () => {
    expect(toKeyValueRows("hello")).toBeNull();
    expect(toKeyValueRows(42)).toBeNull();
    expect(toKeyValueRows([1, 2])).toBeNull();
    expect(toKeyValueRows(null)).toBeNull();
  });

  it("returns empty array for empty objects", () => {
    expect(toKeyValueRows({})).toEqual([]);
  });

  it("truncates oversized values", () => {
    const rows = toKeyValueRows({ text: "a".repeat(1000) })!;
    expect(rows[0][1].length).toBeLessThanOrEqual(ROW_VALUE_MAX_CHARS);
    expect(rows[0][1].endsWith("…")).toBe(true);
  });

  it("parses JSON-string input", () => {
    expect(toKeyValueRows('{"a":1}')).toEqual([["a", "1"]]);
  });
});

describe("prettyJson", () => {
  it("pretty-prints objects with 2-space indent", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("returns null for scalars and circular structures", () => {
    expect(prettyJson("str")).toBeNull();
    expect(prettyJson(5)).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toBeNull();
  });
});

describe("isArrayOfObjects", () => {
  it("true for non-empty arrays of objects", () => {
    expect(isArrayOfObjects([{ a: 1 }, { b: 2 }])).toBe(true);
  });

  it("false for empty, primitive, or mixed arrays", () => {
    expect(isArrayOfObjects([])).toBe(false);
    expect(isArrayOfObjects([1, 2])).toBe(false);
    expect(isArrayOfObjects([{ a: 1 }, "str"])).toBe(false);
    expect(isArrayOfObjects([[1]])).toBe(false);
  });

  it("false for non-arrays", () => {
    expect(isArrayOfObjects({ a: 1 })).toBe(false);
    expect(isArrayOfObjects(null)).toBe(false);
  });
});

describe("looksLikeMarkdown", () => {
  it("detects multiple markdown patterns", () => {
    expect(looksLikeMarkdown("# Title\n\n- item one\n- item two")).toBe(true);
    expect(looksLikeMarkdown("See **docs** and [link](https://x.com)")).toBe(
      true,
    );
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
  });

  it("treats a code fence alone as markdown", () => {
    expect(looksLikeMarkdown("```python\nprint(1)\n```")).toBe(true);
  });

  it("rejects plain prose", () => {
    expect(looksLikeMarkdown("Just a normal sentence about things.")).toBe(
      false,
    );
  });

  it("rejects a single weak pattern", () => {
    // One bullet alone is not enough evidence.
    expect(looksLikeMarkdown("- note")).toBe(false);
  });

  it("rejects JSON dumps", () => {
    expect(looksLikeMarkdown('{"a": 1, "b": 2}')).toBe(false);
  });
});

describe("normalizeResultString", () => {
  it("decodes escaped newlines, quotes, and unicode", () => {
    expect(normalizeResultString('line1\\nline2 \\"q\\" \\u2192 end')).toBe(
      'line1\nline2 "q" → end',
    );
  });

  it("decodes tabs and carriage returns", () => {
    expect(normalizeResultString("a\\tb\\rc")).toBe("a\tb\rc");
  });

  it("preserves escaped backslash + n as literal characters", () => {
    // `\\n` (encoded) means literal backslash + n in the original — never a newline.
    expect(normalizeResultString("path \\\\nstuff")).toBe("path \\nstuff");
  });

  it("leaves strings with real newlines untouched", () => {
    const mixed = "real\nnewline with \\n artifact";
    expect(normalizeResultString(mixed)).toBe(mixed);
  });

  it("leaves artifact-free strings untouched", () => {
    expect(normalizeResultString("just plain text # with symbols")).toBe(
      "just plain text # with symbols",
    );
  });

  it("unlocks markdown detection for escaped results", () => {
    const escaped =
      '# opencode \\"context7\\" auth expired\\n\\n### Summary\\nNone';
    // Escaped form: one line, only the leading heading matches.
    expect(looksLikeMarkdown(escaped)).toBe(false);
    const decoded = normalizeResultString(escaped);
    expect(decoded).toBe(
      '# opencode "context7" auth expired\n\n### Summary\nNone',
    );
    // Real newlines let every heading match — flips to markdown.
    expect(looksLikeMarkdown(decoded)).toBe(true);
  });
});

describe("truncate helpers", () => {
  it("truncateFlat collapses whitespace and caps length", () => {
    expect(truncateFlat("a\n\n  b", 10)).toBe("a b");
    expect(truncateFlat("a".repeat(20), 10)).toBe("aaaaaaaaa…");
  });

  it("truncateFlat keeps short strings intact", () => {
    expect(truncateFlat("short", 10)).toBe("short");
  });

  it("truncateRaw preserves whitespace but caps length", () => {
    expect(truncateRaw("a\nb", 10)).toBe("a\nb");
    expect(truncateRaw("a".repeat(20), 5).length).toBe(5);
  });
});
