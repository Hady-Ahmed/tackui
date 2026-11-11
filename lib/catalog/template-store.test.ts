import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  listTemplates,
  getTemplate,
  getTemplateBySlug,
  getTemplatesByIds,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  createTemplateBodySchema,
  updateTemplateBodySchema,
  toPublicTemplate,
  countTemplateInstalls,
  findInstalledAgentId,
  installTemplate,
  getRunUsage,
  annotateAgentTemplateState,
} from "./template-store";
import { toPublicAgent } from "@/lib/agents/agent-store";
import type { CreateTemplateInput } from "./template-store";
import { TemplateInstallConflictError, TemplateInstallVanishedError } from "./template-store";
import type { AgentTemplate } from "./catalog.config";
import { runMigrations } from "@/lib/db/migrate";
import { query, withTransaction } from "@/lib/db/pg";
import type { PgQueryable } from "@/lib/db/pg";
import { useRealPostgres } from "@/lib/db/test-postgres";
import { createAgent, listAgents, deleteAgent } from "@/lib/agents/agent-store";
import type {
  QueryConfigValues,
  QueryResult,
  QueryResultRow,
} from "pg";

// Passthrough wrapper around @/lib/db/pg with two seams:
//   - pgCounters counts withTransaction calls — proof that
//     updateTemplate's read-merge-write runs inside one transaction (the
//     issue-#127 serialization boundary) without reimplementing the runner.
//   - pgScript arms per-test failure injection: `queryScript` scripts
//     module-level query() results/throws by SQL text (the installTemplate
//     lost-race tests), `txFailure` makes ONE matching statement throw
//     inside the transaction client (the deleteTemplate rollback test —
//     which runs against real Postgres, since pg-mem cannot roll back
//     cross-statement mutations). Both default null = full passthrough.
const pgCounters = vi.hoisted(() => ({ withTransaction: 0 }));
const pgScript = vi.hoisted(() => ({
  queryScript: null as null | ((text: string) => unknown),
  txFailure: null as null | { match: string; error: Error },
}));
vi.mock("@/lib/db/pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg")>();
  return {
    ...actual,
    query: async <T extends QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<T>> => {
      const scripted = pgScript.queryScript?.(text);
      return scripted !== undefined
        ? (scripted as QueryResult<T>)
        : actual.query<T>(text, values);
    },
    withTransaction: (fn: Parameters<typeof actual.withTransaction>[0]) => {
      pgCounters.withTransaction += 1;
      const failure = pgScript.txFailure;
      if (!failure) return actual.withTransaction(fn);
      // Every statement of the transaction still runs against the real
      // client — only the one whose SQL matches rejects, so the runner's
      // own ROLLBACK (not a stub) is what gets exercised.
      return actual.withTransaction((client) =>
        fn({
          query: async <T extends QueryResultRow>(
            text: string,
            values?: QueryConfigValues<unknown[]>,
          ): Promise<QueryResult<T>> => {
            if (text.includes(failure.match)) throw failure.error;
            return client.query<T>(text, values);
          },
        } as PgQueryable),
      );
    },
  };
});

const TEST_ORG = "test-org-id";
const OTHER_ORG = "other-org-id";

// Deterministic 32-byte hex key — store round-trips run with encryption
// enabled (same convention as agent-store.test.ts).
const ENCRYPTION_TEST_KEY = "ab".repeat(32);

beforeAll(() => {
  vi.stubEnv("DB_ENCRYPTION_KEY", ENCRYPTION_TEST_KEY);
  // Inline test env (never env files): shrink the REAL-Postgres harness
  // pool below the writer count of the hot-row pool-exhaustion test in
  // "updateTemplate concurrency" so the no-pinned-connections invariant is
  // proven deterministically. The harness pool is created lazily on the
  // first useRealPostgres() call, so these are read then; afterAll's
  // unstub keeps a reused vitest worker from leaking them into other files.
  vi.stubEnv("PG_POOL_MAX", "2");
  vi.stubEnv("PG_CONNECT_TIMEOUT", "750");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const validInput: CreateTemplateInput = {
  name: "Flight Finder",
  slug: "flight-finder",
  tagline: "Find cheap flights",
  description: "Searches live fares across airlines",
  endpoint: "http://localhost:8000/agent",
  authMode: "none",
  sortOrder: 0,
  isActive: true,
};

async function cleanup() {
  // Delete all installed agents (any org) + all templates. No
  // bypassOrgScope needed — agents deletes by id work cross-org via the
  // same helper the agents tests use.
  for (const a of await listAgents(TEST_ORG, { bypassOrgScope: true })) {
    await deleteAgent(a.id, TEST_ORG, { bypassOrgScope: true });
  }
  await query(`DELETE FROM agent_templates`);
  await query(`DELETE FROM agent_runs`);
  await query(`DELETE FROM thread_metadata`);
}

beforeEach(async () => {
  await runMigrations();
  await cleanup();
  // Reset AFTER setup: runMigrations itself wraps its run in
  // withTransaction, and the counter must count the test's own calls only.
  pgCounters.withTransaction = 0;
  pgScript.queryScript = null;
  pgScript.txFailure = null;
});

describe("createTemplateBodySchema", () => {
  it("accepts a valid body (no id)", () => {
    const result = createTemplateBodySchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("strips `id` if a client sends it (defense-in-depth)", () => {
    const result = createTemplateBodySchema.safeParse({ ...validInput, id: "attacker" });
    expect(result.success).toBe(true);
    expect(result.success && "id" in result.data).toBe(false);
  });

  it("rejects slugs with invalid characters", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      slug: "Flight Finder!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects multi-line taglines (single-line field — line breaks belong in the description)", () => {
    expect(
      createTemplateBodySchema.safeParse({
        ...validInput,
        tagline: "Line one\nLine two",
      }).success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({
        ...validInput,
        tagline: "Line one\r\nLine two",
      }).success,
    ).toBe(false);
    // Multi-line descriptions stay legal (rendered as real breaks).
    expect(
      createTemplateBodySchema.safeParse({
        ...validInput,
        description: "Line one\nLine two",
      }).success,
    ).toBe(true);
  });

  it("rejects non-URL endpoints", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      endpoint: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects requiredPlan values outside pro/team", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      requiredPlan: "free",
    });
    expect(result.success).toBe(false);
  });

  it("rejects freeDailyQuota < 1 or non-integer", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 0 }).success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects freeDailyQuota set together with requiredPlan (contradictory)", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      requiredPlan: "pro",
      freeDailyQuota: 10,
    });
    expect(result.success).toBe(false);
  });

  it("accepts requiredPlan without a quota", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      requiredPlan: "pro",
    });
    expect(result.success).toBe(true);
  });

  it("rejects paidDailyQuota < 1 or non-integer", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 10, paidDailyQuota: 0 })
        .success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 10, paidDailyQuota: 1.5 })
        .success,
    ).toBe(false);
  });

  it("rejects paidDailyQuota on an ungated template without freeDailyQuota (paid can't be worse off than free)", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, paidDailyQuota: 100 }).success,
    ).toBe(false);
  });

  it("accepts paidDailyQuota alongside freeDailyQuota (per-tier caps)", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 10, paidDailyQuota: 100 })
        .success,
    ).toBe(true);
  });

  it("accepts paidDailyQuota alongside requiredPlan (gated templates can cap paid usage)", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, requiredPlan: "pro", paidDailyQuota: 100 })
        .success,
    ).toBe(true);
  });

  it("rejects paidDailyQuota <= freeDailyQuota (Pro is the higher tier)", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 10, paidDailyQuota: 10 })
        .success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 10, paidDailyQuota: 5 })
        .success,
    ).toBe(false);
  });

  it("rejects jwtSecret shorter than 32 chars", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty or whitespace-only tagline/description", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, tagline: "" }).success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, tagline: "   " }).success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, description: "" }).success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, description: "  " }).success,
    ).toBe(false);
  });

  it("trims tagline/description", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      tagline: "  padded  ",
      description: " padded ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tagline).toBe("padded");
      expect(result.data.description).toBe("padded");
    }
  });

  it("accepts single-emoji icons across Unicode tricks", () => {
    // Every real emoji is exactly one Intl.Segmenter grapheme cluster —
    // including ZWJ sequences, flags, keycaps, and skin-tone modifiers.
    for (const icon of ["✈️", "👨‍👩‍👧‍👦", "🇹🇷", "1️⃣", "🫱🏻‍🫲🏽", "🏳️‍🌈"]) {
      expect(createTemplateBodySchema.safeParse({ ...validInput, icon }).success).toBe(true);
    }
  });

  it("rejects words and other pure-ASCII icons", () => {
    // The original bug: "hady" passed the old max(16) length cap and
    // rendered as giant text in the card's emoji slot.
    for (const icon of ["hady", "Travel", "a", "", "   ", "<script>"]) {
      expect(createTemplateBodySchema.safeParse({ ...validInput, icon }).success).toBe(false);
    }
  });

  it("rejects multi-emoji and emoji+letter mixes (2+ grapheme clusters)", () => {
    expect(createTemplateBodySchema.safeParse({ ...validInput, icon: "🚀🚀" }).success).toBe(false);
    expect(createTemplateBodySchema.safeParse({ ...validInput, icon: "h🚀" }).success).toBe(false);
  });

  it("trims surrounding whitespace off icons before validating", () => {
    const result = createTemplateBodySchema.safeParse({ ...validInput, icon: " ✈️ " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.icon).toBe("✈️");
    }
  });
});

describe("updateTemplateBodySchema", () => {
  it("accepts a partial body", () => {
    expect(updateTemplateBodySchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateTemplateBodySchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateTemplateBodySchema.safeParse({}).success).toBe(true);
  });

  it("rejects an empty tagline/description when present", () => {
    expect(updateTemplateBodySchema.safeParse({ tagline: "" }).success).toBe(false);
    expect(updateTemplateBodySchema.safeParse({ description: "" }).success).toBe(false);
  });

  it("rejects multi-line taglines when present (field-level refine survives .partial())", () => {
    expect(
      updateTemplateBodySchema.safeParse({ tagline: "Line one\nLine two" }).success,
    ).toBe(false);
  });

  it("accepts explicit null on clearable fields", () => {
    const result = updateTemplateBodySchema.safeParse({
      category: null,
      icon: null,
      requiredPlan: null,
      freeDailyQuota: null,
      paidDailyQuota: null,
    });
    expect(result.success).toBe(true);
  });

  it("applies the single-emoji rule to patched icons too", () => {
    expect(updateTemplateBodySchema.safeParse({ icon: "🚀" }).success).toBe(true);
    expect(updateTemplateBodySchema.safeParse({ icon: "hady" }).success).toBe(false);
    expect(updateTemplateBodySchema.safeParse({ icon: "🚀🚀" }).success).toBe(false);
  });

  it("defers paidDailyQuota context rules to merged-row validation when freeDailyQuota is absent", () => {
    // A patch setting only paidDailyQuota can't know the stored free
    // tier — accepted here; updateTemplate re-validates the merged state.
    expect(updateTemplateBodySchema.safeParse({ paidDailyQuota: 100 }).success).toBe(true);
    expect(updateTemplateBodySchema.safeParse({ paidDailyQuota: null }).success).toBe(true);
  });

  it("rejects paidDailyQuota set together with an explicit freeDailyQuota clear on an ungated patch", () => {
    expect(
      updateTemplateBodySchema.safeParse({ paidDailyQuota: 100, freeDailyQuota: null }).success,
    ).toBe(false);
  });

  it("rejects a sub-minimum jwtSecret (write-only — blank means keep, not clear)", () => {
    expect(updateTemplateBodySchema.safeParse({ jwtSecret: "" }).success).toBe(false);
    expect(updateTemplateBodySchema.safeParse({ jwtSecret: "short" }).success).toBe(false);
  });
});

describe("createTemplate / getTemplate / listTemplates", () => {
  it("creates a template with a server-generated id and reads it back", async () => {
    const created = await createTemplate(validInput);
    expect(created.id).toMatch(/^[0-9a-f]{12}$/);
    expect(created.slug).toBe("flight-finder");
    expect(created.tagline).toBe("Find cheap flights");
    expect(created.isActive).toBe(true);
    expect(created.requiredPlan).toBeUndefined();
    expect(created.freeDailyQuota).toBeUndefined();

    const fetched = await getTemplate(created.id);
    expect(fetched?.name).toBe("Flight Finder");
    expect(fetched?.updatedAt).toBe(created.updatedAt);
  });

  it("getTemplateBySlug resolves by slug", async () => {
    const created = await createTemplate(validInput);
    const fetched = await getTemplateBySlug("flight-finder");
    expect(fetched?.id).toBe(created.id);
    expect(await getTemplateBySlug("missing")).toBeNull();
  });

  it("listTemplates({ activeOnly }) filters deactivated templates", async () => {
    const active = await createTemplate(validInput);
    await createTemplate({ ...validInput, slug: "inactive-one", isActive: false });
    const all = await listTemplates({ activeOnly: false });
    expect(all).toHaveLength(2);
    const activeOnly = await listTemplates({ activeOnly: true });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].id).toBe(active.id);
  });

  it("listTemplates orders by sort_order then created_at", async () => {
    const a = await createTemplate({ ...validInput, slug: "a", sortOrder: 5 });
    const b = await createTemplate({ ...validInput, slug: "b", sortOrder: 1 });
    const c = await createTemplate({ ...validInput, slug: "c", sortOrder: 5 });
    const list = await listTemplates({ activeOnly: false });
    expect(list.map((t) => t.id)).toEqual([b.id, a.id, c.id]);
  });

  it("toPublicTemplate strips jwtSecret, exposes boolean + gates", async () => {
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      requiredPlan: "pro",
    });
    const pub = toPublicTemplate(created);
    expect(pub.hasJwtSecret).toBe(true);
    expect("jwtSecret" in pub).toBe(false);
    expect(pub.requiredPlan).toBe("pro");
  });
});

describe("jwt secret encryption at rest (templates)", () => {
  it("stores jwt_secret as ciphertext and reads back plaintext", async () => {
    const secret = "s".repeat(32);
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: secret,
    });
    const raw = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agent_templates WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0].jwt_secret).toMatch(/^enc:v1:/);
    expect(raw.rows[0].jwt_secret).not.toContain(secret);
    expect((await getTemplate(created.id))!.jwtSecret).toBe(secret);
  });
});

describe("updateTemplate", () => {
  it("updates fields and returns the updated template", async () => {
    const created = await createTemplate(validInput);
    const updated = await updateTemplate(created.id, { name: "Renamed", tagline: "New tagline" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.tagline).toBe("New tagline");
    expect(updated?.endpoint).toBe(validInput.endpoint);
  });

  it("returns null for missing template", async () => {
    expect(await updateTemplate("nonexistent", { name: "X" })).toBeNull();
  });

  it("preserves jwtSecret when patch omits it (blank-preserve)", async () => {
    const secret = "s".repeat(32);
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: secret,
    });
    const updated = await updateTemplate(created.id, { name: "Renamed" });
    expect(updated?.jwtSecret).toBe(secret);
  });

  it("overwrites jwtSecret when patch provides a new value", async () => {
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    });
    const updated = await updateTemplate(created.id, { jwtSecret: "t".repeat(40) });
    expect(updated?.jwtSecret).toBe("t".repeat(40));
  });

  it("preserves UNDECRYPTABLE stored ciphertext byte-for-byte when the patch omits jwtSecret", async () => {
    // SECURITY rule: test the bypass attempt. The old behavior wrote NULL
    // whenever the merged row had no USABLE secret — and rowToTemplate
    // degrades an undecryptable ciphertext to secret-less — so an
    // unrelated edit (a rename) silently DESTROYED the stored ciphertext
    // (key rotation / backup mismatch), unrecoverable even after the
    // key is restored. The fixture below never decrypts under the test
    // key, so under the old behavior this assertion fails: the column
    // would read NULL instead of the preserved bytes.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    });
    const GARBAGE = "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==";
    await query(
      `UPDATE agent_templates SET jwt_secret = $1 WHERE id = $2`,
      [GARBAGE, created.id],
    );

    const updated = await updateTemplate(created.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");

    // Byte-for-byte preserved — NOT nulled, NOT re-encrypted.
    const raw = await query<{ jwt_secret: string | null }>(
      `SELECT jwt_secret FROM agent_templates WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0].jwt_secret).toBe(GARBAGE);
    // And the read-path contract is unchanged: the row still DEGRADES to
    // secret-less rather than surfacing garbage as a secret.
    expect((await getTemplate(created.id))?.jwtSecret).toBeUndefined();
    errSpy.mockRestore();
  });

  it("a patch supplying a new secret REPLACES undecryptable ciphertext (recovery path)", async () => {
    // Preservation must not be a trap: entering a fresh secret is the
    // documented recovery from an undecryptable row, and it must win.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    });
    await query(
      `UPDATE agent_templates SET jwt_secret = 'enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==' WHERE id = $1`,
      [created.id],
    );
    const newSecret = "t".repeat(32);
    const updated = await updateTemplate(created.id, { jwtSecret: newSecret });
    expect(updated?.jwtSecret).toBe(newSecret);
    expect((await getTemplate(created.id))?.jwtSecret).toBe(newSecret);
    errSpy.mockRestore();
  });

  it("a patch on a secret-less template still stores NULL (no accidental write)", async () => {
    // The preservation path reads the raw column and writes it back — for
    // a template that never had a secret that must stay NULL, not become
    // some sentinel value.
    const created = await createTemplate(validInput);
    const updated = await updateTemplate(created.id, { name: "Renamed" });
    expect(updated?.jwtSecret).toBeUndefined();
    const raw = await query<{ jwt_secret: string | null }>(
      `SELECT jwt_secret FROM agent_templates WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0].jwt_secret).toBeNull();
  });

  it("clears clearable fields on explicit null, preserves on absent", async () => {
    const created = await createTemplate({
      ...validInput,
      category: "travel",
      icon: "✈️",
      requiredPlan: undefined,
      freeDailyQuota: 10,
    });
    // Absent keys preserve.
    const kept = await updateTemplate(created.id, { name: "Still gated quota" });
    expect(kept?.category).toBe("travel");
    expect(kept?.icon).toBe("✈️");
    expect(kept?.freeDailyQuota).toBe(10);
    // Explicit null clears.
    const cleared = await updateTemplate(created.id, {
      category: null,
      icon: null,
      freeDailyQuota: null,
    });
    expect(cleared?.category).toBeUndefined();
    expect(cleared?.icon).toBeUndefined();
    expect(cleared?.freeDailyQuota).toBeUndefined();
  });

  it("validates the merged row (rejection throws)", async () => {
    const created = await createTemplate(validInput);
    await expect(
      updateTemplate(created.id, { endpoint: "not-a-url" }),
    ).rejects.toThrow();
  });

  it("stores, preserves, and clears paidDailyQuota", async () => {
    const created = await createTemplate({
      ...validInput,
      freeDailyQuota: 10,
      paidDailyQuota: 100,
    });
    expect(created.paidDailyQuota).toBe(100);
    // Absent keys preserve.
    const kept = await updateTemplate(created.id, { name: "Renamed" });
    expect(kept?.freeDailyQuota).toBe(10);
    expect(kept?.paidDailyQuota).toBe(100);
    // Explicit null clears only the paid cap.
    const cleared = await updateTemplate(created.id, { paidDailyQuota: null });
    expect(cleared?.paidDailyQuota).toBeUndefined();
    expect(cleared?.freeDailyQuota).toBe(10);
  });

  it("rejects a merged row where paidDailyQuota lacks a free tier on an ungated template", async () => {
    const created = await createTemplate(validInput);
    await expect(
      updateTemplate(created.id, { paidDailyQuota: 100 }),
    ).rejects.toThrow();
  });

  it("rejects an empty tagline on the merged row", async () => {
    const created = await createTemplate(validInput);
    await expect(
      updateTemplate(created.id, { tagline: "" }),
    ).rejects.toThrow();
  });

  it("rejects a merged row where quota + plan gate conflict", async () => {
    const created = await createTemplate({ ...validInput, freeDailyQuota: 10 });
    await expect(
      updateTemplate(created.id, { requiredPlan: "pro" }),
    ).rejects.toThrow();
  });

  it("runs the read-merge-write inside ONE transaction (withTransaction per update)", async () => {
    const created = await createTemplate(validInput);
    const updated = await updateTemplate(created.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(pgCounters.withTransaction).toBe(1);
  });
});

describe("updateTemplate concurrency (real Postgres)", () => {
  it("serializes a concurrent rename + secret re-save — both survive (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      // The container persists across this file's tests (beforeEach's
      // cleanup runs against pg-mem, not here) — clear the table so
      // validInput's unique slug is free.
      await query(`DELETE FROM agent_templates`);
      const created = await createTemplate({
        ...validInput,
        authMode: "jwt",
        jwtSecret: "s".repeat(32),
      });

      // Hold the template row's lock from OUTSIDE both updates so each
      // one's read-merge-write QUEUES behind it. Under the fix each call
      // blocks at its SELECT ... FOR UPDATE and reads only after the
      // previous writer committed. (Unserialized, both calls read the
      // ORIGINAL row before either write — the rename's write-back then
      // carries the stale pre-save secret bytes and the just-saved secret
      // is silently destroyed.)
      let pending!: Promise<(AgentTemplate | null)[]>;
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT id FROM agent_templates WHERE id = $1 FOR UPDATE`,
          [created.id],
        );
        pending = Promise.all([
          updateTemplate(created.id, { name: "Renamed" }),
          updateTemplate(created.id, { jwtSecret: "t".repeat(32) }),
        ]);
        // Give both updates time to reach their lock wait, then release
        // the holder (COMMIT) — from here the updates proceed one at a
        // time, the second merging over the first's committed row.
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      const [renamed, secreted] = await pending;
      expect(renamed).not.toBeNull();
      expect(secreted).not.toBeNull();
      // THE assertion: both concurrent edits landed — the rename AND the
      // new secret decrypt (the rename didn't carry back the old secret).
      const after = await getTemplate(created.id);
      expect(after?.name).toBe("Renamed");
      expect(after?.jwtSecret).toBe("t".repeat(32));
    } finally {
      restore();
    }
  });

  it("the template row lock is a real serialization point: a competing FOR UPDATE waits, then times out (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip();
      return;
    }
    try {
      await query(`DELETE FROM agent_templates`);
      const created = await createTemplate(validInput);
      // tx1 takes updateTemplate's lock and holds it; tx2 — the same
      // shape of statement the update runs — must block on that row.
      // Proves FOR UPDATE genuinely conflicts across connections (pg-mem
      // has no locking, so only real Postgres can answer this).
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT id FROM agent_templates WHERE id = $1 FOR UPDATE`,
          [created.id],
        );
        await expect(
          withTransaction(async (competing) => {
            // Transaction-local so nothing outlives this tx.
            await competing.query(`SET LOCAL lock_timeout = '250ms'`);
            await competing.query(
              `SELECT id FROM agent_templates WHERE id = $1 FOR UPDATE`,
              [created.id],
            );
          }),
        ).rejects.toMatchObject({ code: "55P03" }); // lock_not_available
      });
    } finally {
      restore();
    }
  });

  it("more concurrent same-row writers than PG_POOL_MAX all complete — blocked writers queue in-process, never pinning a pool connection (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      await query(`DELETE FROM agent_templates`);
      const created = await createTemplate(validInput);
      // 4x the shrunken harness pool (PG_POOL_MAX=2, stubbed in beforeAll).
      const WRITERS = 8;

      let pending!: Promise<(AgentTemplate | null)[]>;
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT id FROM agent_templates WHERE id = $1 FOR UPDATE`,
          [created.id],
        );
        pending = Promise.all(
          Array.from({ length: WRITERS }, (_, i) =>
            updateTemplate(created.id, { name: `Writer ${i}` }),
          ),
        );
        // Hold the row lock LONGER than PG_CONNECT_TIMEOUT (750ms, also
        // stubbed in beforeAll). Without the per-key semaphore, every
        // writer opens its transaction up front: 2 connections get
        // granted and immediately block on the row lock, so the other 6
        // time out waiting for a connection before the holder commits at
        // 1.5s. With the semaphore (acquired BEFORE the transaction), a
        // writer only touches the pool once admitted, a connection is
        // always free for it — all 8 complete.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      });

      const results = await pending;
      // THE assertion: no writer timed out waiting for a connection —
      // every one of the 8 writers (pool max 2) committed its update.
      expect(results).toHaveLength(WRITERS);
      expect(results.every((r) => r !== null)).toBe(true);
      const after = await getTemplate(created.id);
      expect(after?.name).toMatch(/^Writer \d$/);
    } finally {
      restore();
    }
  }, 30_000);
});

describe("deleteTemplate transactional invariant (real Postgres)", () => {
  it("an error between the DELETE and the tombstone UPDATE rolls BOTH back — no half-deleted state (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      // The container persists across this file's real-PG tests (and
      // beforeEach's cleanup runs against pg-mem) — clear what this test
      // touches so its slug and org are free.
      await query(`DELETE FROM agent_templates`);
      await query(`DELETE FROM agents WHERE org_id = $1`, [TEST_ORG]);
      const template = await createTemplate(validInput);
      const { agent } = await installTemplate(template, TEST_ORG);

      // Make the tombstone UPDATE throw AFTER the template DELETE has
      // succeeded — the exact mid-transaction window the one-transaction
      // comment guards against. (pg-mem can't roll back cross-statement
      // mutations, so this invariant is only provable on real Postgres.)
      pgScript.txFailure = {
        match: "template_deleted_at",
        error: new Error("tombstone update failed"),
      };
      try {
        await expect(deleteTemplate(template.id)).rejects.toThrow(
          "tombstone update failed",
        );
      } finally {
        pgScript.txFailure = null;
      }

      // THE assertion: nothing half-applied. The template row survived the
      // rollback (the delete was undone), and the installed copy carries
      // NO tombstone — still live and runnable, not a ghost "Removed" copy
      // referencing a template that no longer exists.
      expect(await getTemplate(template.id)).not.toBeNull();
      const after = await query<{ template_deleted_at: Date | string | null }>(
        `SELECT template_deleted_at FROM agents WHERE id = $1`,
        [agent.id],
      );
      expect(after.rows[0]?.template_deleted_at).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("deleteTemplate + countTemplateInstalls", () => {
  it("deletes a template and returns true; false when missing", async () => {
    const created = await createTemplate(validInput);
    expect(await deleteTemplate(created.id)).toBe(true);
    expect(await getTemplate(created.id)).toBeNull();
    expect(await deleteTemplate("nonexistent")).toBe(false);
  });

  it("countTemplateInstalls counts installed copies across orgs", async () => {
    const created = await createTemplate(validInput);
    expect(await countTemplateInstalls(created.id)).toBe(0);
    await installTemplate(created, TEST_ORG);
    await installTemplate(created, OTHER_ORG);
    expect(await countTemplateInstalls(created.id)).toBe(2);
  });

  it("deleting a template tombstones installed copies (listed, not runnable)", async () => {
    const created = await createTemplate(validInput);
    const { agent } = await installTemplate(created, TEST_ORG);
    await deleteTemplate(created.id);
    // The row survives as a tombstone — still listed so past
    // conversations remain browsable.
    const agents = await listAgents(TEST_ORG);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(agent.id);
    expect(agents[0].sourceTemplateId).toBe(created.id);
    expect(agents[0].templateRemovedAt).toBeTruthy();
    // And the public shape keeps the flag too.
    const pub = toPublicAgent(agents[0]);
    expect(pub.templateRemovedAt).toBeTruthy();
    expect("endpoint" in pub).toBe(false);
  });

  it("getTemplatesByIds resolves a batch and omits missing ids", async () => {
    const a = await createTemplate({ ...validInput, slug: "a" });
    const b = await createTemplate({ ...validInput, slug: "b" });
    const found = await getTemplatesByIds([a.id, b.id, "missing-id"]);
    expect(found).toHaveLength(2);
    expect(found.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(await getTemplatesByIds([])).toEqual([]);
  });
});

describe("installTemplate (idempotent upsert)", () => {
  it("creates an agent stamped with source_template_id + copied config", async () => {
    const template = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run"],
    });
    const result = await installTemplate(template, TEST_ORG);
    expect(result.installed).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.agent.id).toMatch(/^[0-9a-f]{12}$/);
    expect(result.agent.name).toBe(template.name);
    expect(result.agent.endpoint).toBe(template.endpoint);
    expect(result.agent.authMode).toBe("jwt");
    expect(result.agent.jwtSecret).toBe("s".repeat(32));
    expect(result.agent.jwtScopes).toEqual(["agents:run"]);
    expect(result.agent.sourceTemplateId).toBe(template.id);
    expect(result.agent.installedTemplateUpdatedAt).toBe(template.updatedAt);

    // Scoped to the installing org only.
    expect(await listAgents(OTHER_ORG)).toHaveLength(0);
  });

  it("re-install re-syncs config onto the SAME agent row (id preserved)", async () => {
    const template = await createTemplate(validInput);
    const first = await installTemplate(template, TEST_ORG);
    const originalId = first.agent.id;

    // Curator fixes the endpoint + rotates the secret.
    const updatedTemplate = await updateTemplate(template.id, {
      endpoint: "http://localhost:9000/agent",
      jwtSecret: "rotated".padEnd(32, "x"),
    });

    const second = await installTemplate(updatedTemplate!, TEST_ORG);
    expect(second.installed).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.agent.id).toBe(originalId);
    expect(second.agent.endpoint).toBe("http://localhost:9000/agent");
    expect(second.agent.jwtSecret).toBe("rotated".padEnd(32, "x"));
    expect(await listAgents(TEST_ORG)).toHaveLength(1);
  });

  it("re-sync with an UNDECRYPTABLE template jwt_secret preserves the agent's existing secret", async () => {
    // Template created WITH a secret; the template row's ciphertext is
    // then corrupted (key rotation / backup mismatch). rowToTemplate
    // downgrades that to secret-less — but the re-sync must not null the
    // agent row's previously-synced working secret (the tombstone
    // fallback would lose its auth).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const template = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    });
    const first = await installTemplate(template, TEST_ORG);
    expect(first.agent.jwtSecret).toBe("s".repeat(32));

    await query(
      `UPDATE agent_templates SET jwt_secret = 'enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==' WHERE id = $1`,
      [template.id],
    );
    const reread = await getTemplate(template.id);
    expect(reread?.jwtSecret).toBeUndefined();

    const second = await installTemplate(reread!, TEST_ORG);
    expect(second.installed).toBe(false);
    expect(second.agent.jwtSecret).toBe("s".repeat(32));
    expect(second.agent.authMode).toBe("jwt");
    errSpy.mockRestore();
  });

  it("re-install with no template change reports updated: false", async () => {
    const template = await createTemplate(validInput);
    await installTemplate(template, TEST_ORG);
    const again = await installTemplate(template, TEST_ORG);
    expect(again.installed).toBe(false);
    expect(again.updated).toBe(false);
  });

  it("installs into different orgs produce distinct agent rows", async () => {
    const template = await createTemplate(validInput);
    const a = await installTemplate(template, TEST_ORG);
    const b = await installTemplate(template, OTHER_ORG);
    expect(a.agent.id).not.toBe(b.agent.id);
    expect(await findInstalledAgentId(template.id, TEST_ORG)).toBe(a.agent.id);
    expect(await findInstalledAgentId(template.id, OTHER_ORG)).toBe(b.agent.id);
    expect(await findInstalledAgentId("missing-template", TEST_ORG)).toBeNull();
  });

  it("two concurrent installs of the same template produce exactly ONE agent row", async () => {
    // The find-then-insert race: both calls observe "not installed", both
    // INSERT. Migration 0015's partial unique index makes the second
    // INSERT fail with 23505; the loser falls back to re-syncing the
    // winner's row. The invariant holds regardless of which call wins:
    // one row, and both results point at it.
    const template = await createTemplate(validInput);
    const [a, b] = await Promise.all([
      installTemplate(template, TEST_ORG),
      installTemplate(template, TEST_ORG),
    ]);
    const rows = await listAgents(TEST_ORG);
    expect(rows).toHaveLength(1);
    expect(new Set([a.agent.id, b.agent.id]).size).toBe(1);
    expect(await findInstalledAgentId(template.id, TEST_ORG)).toBe(a.agent.id);
  });

  it("loses-race fallback: the first winner lookup misses, the RETRY sees the winner and re-syncs it", async () => {
    const template = await createTemplate(validInput);
    const winner = await installTemplate(template, TEST_ORG);
    // The race, replayed against the committed winner: the loser's initial
    // lookup misses (its snapshot predates the winner's commit), the INSERT
    // hits migration 0015's unique index (23505), the FIRST fallback lookup
    // misses AGAIN (same stale snapshot) — and the retry, a fresh read,
    // finally sees the winner. Script: lookups 1-2 miss, lookup 3 hits;
    // every INSERT raises the unique violation.
    let lookups = 0;
    pgScript.queryScript = (text) => {
      if (text.startsWith("INSERT INTO agents")) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "agents_org_template_uniq"'),
          { code: "23505" },
        );
      }
      if (text.includes("source_template_id = $2")) {
        lookups += 1;
        return lookups < 3 ? { rows: [] } : { rows: [{ id: winner.agent.id }] };
      }
      return undefined;
    };
    try {
      const result = await installTemplate(template, TEST_ORG);
      expect(lookups).toBe(3); // initial miss + fallback miss + retry hit
      expect(result.installed).toBe(false);
      expect(result.agent.id).toBe(winner.agent.id);
    } finally {
      pgScript.queryScript = null;
    }
    // Still exactly one row — the loser joined the winner, no duplicate.
    expect(await listAgents(TEST_ORG)).toHaveLength(1);
  });

  it("loses-race fallback: a winner that stays invisible to BOTH lookups surfaces as a typed conflict, not the raw 23505", async () => {
    const template = await createTemplate(validInput);
    // The pathological visibility race: the 23505 PROVES the winner's row
    // is committed, yet it never becomes visible to the loser's reads —
    // the first fallback lookup AND its retry both miss. This used to
    // rethrow the raw 23505, which the route's catch-all turned into a
    // bare 500.
    pgScript.queryScript = (text) => {
      if (text.startsWith("INSERT INTO agents")) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "agents_org_template_uniq"'),
          { code: "23505" },
        );
      }
      if (text.includes("source_template_id = $2")) return { rows: [] };
      return undefined;
    };
    try {
      await expect(installTemplate(template, TEST_ORG)).rejects.toBeInstanceOf(
        TemplateInstallConflictError,
      );
    } finally {
      pgScript.queryScript = null;
    }
    // No half-installed row either: the INSERT failed and no fallback ran.
    expect(await listAgents(TEST_ORG)).toHaveLength(0);
  });

  it("re-sync: the installed row vanishing mid-call surfaces as a typed error, not a 500", async () => {
    const template = await createTemplate(validInput);
    const { agent } = await installTemplate(template, TEST_ORG);
    // The lookup that produced existingId saw the row; its org then deleted
    // the agent before the re-sync's reads (nothing holds the row). Script:
    // the lookup still hands back the now-stale id; everything downstream
    // runs against the real DB where the row is gone. This used to blow up
    // on a non-null assertion — getAgent returned null, the route's
    // catch-all turned the missing agent into a bare 500.
    await deleteAgent(agent.id, TEST_ORG, { bypassOrgScope: true });
    pgScript.queryScript = (text) => {
      if (text.includes("source_template_id = $2")) {
        return { rows: [{ id: agent.id }] };
      }
      return undefined;
    };
    try {
      await expect(installTemplate(template, TEST_ORG)).rejects.toBeInstanceOf(
        TemplateInstallVanishedError,
      );
    } finally {
      pgScript.queryScript = null;
    }
  });

  it("loses-race fallback: the winner's row vanishing mid-call surfaces as the same typed error", async () => {
    const template = await createTemplate(validInput);
    const winner = await installTemplate(template, TEST_ORG);
    await deleteAgent(winner.agent.id, TEST_ORG, { bypassOrgScope: true });
    // The full race, replayed with the winner's row already deleted: the
    // loser's initial lookup misses (lookups 1), the INSERT raises the
    // unique violation, and the first fallback lookup returns the now-stale
    // winner id (lookups 2 — enough for the `??` to short-circuit, so the
    // retry lookup never runs). The re-sync's reads then find nothing.
    // Used to 500.
    let lookups = 0;
    pgScript.queryScript = (text) => {
      if (text.startsWith("INSERT INTO agents")) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "agents_org_template_uniq"'),
          { code: "23505" },
        );
      }
      if (text.includes("source_template_id = $2")) {
        lookups += 1;
        return lookups === 1
          ? { rows: [] }
          : { rows: [{ id: winner.agent.id }] };
      }
      return undefined;
    };
    try {
      await expect(installTemplate(template, TEST_ORG)).rejects.toBeInstanceOf(
        TemplateInstallVanishedError,
      );
      expect(lookups).toBe(2);
    } finally {
      pgScript.queryScript = null;
    }
  });

  it("the partial unique index blocks duplicates at the DB level but not manual agents", async () => {
    const template = await createTemplate(validInput);
    await installTemplate(template, TEST_ORG);

    // A second installed copy for the same (org, template) is rejected.
    await expect(
      query(
        `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode, source_template_id)
         VALUES ('ffffffffffff', 'Dup', 'd', 'http://localhost:8000/agent', $1, 'none', $2)`,
        [TEST_ORG, template.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // The index is PARTIAL: manually-created agents (NULL
    // source_template_id) can share an org freely — NULLs are distinct.
    await expect(
      query(
        `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode)
         VALUES ('aaaaaaaaaaaa', 'Manual A', 'd', 'http://localhost:8000/agent', $1, 'none')`,
        [TEST_ORG],
      ),
    ).resolves.toBeTruthy();
    await expect(
      query(
        `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode)
         VALUES ('bbbbbbbbbbbb', 'Manual B', 'd', 'http://localhost:8000/agent', $1, 'none')`,
        [TEST_ORG],
      ),
    ).resolves.toBeTruthy();
  });
});

describe("annotateAgentTemplateState (curator-state chips)", () => {
  it("copies the live template's requiredPlan onto managed agents", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "gated-live",
      requiredPlan: "pro",
    });
    const { agent } = await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.id).toBe(agent.id);
    expect(pub.templateRequiredPlan).toBe("pro");
  });

  it("stamps the live template's tagline/description onto managed agents (display copy propagates, no re-install)", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "copy-live",
      tagline: "Live tagline",
      description: "Live description",
    });
    const { agent } = await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.id).toBe(agent.id);
    expect(pub.templateTagline).toBe("Live tagline");
    expect(pub.templateDescription).toBe("Live description");
  });

  it("stamps live copy on paused (deactivated-template) agents too — the template row still exists", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "copy-paused",
      tagline: "Paused tagline",
      description: "Paused description",
      icon: "⏸️",
      isActive: false,
    });
    await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.templateUnpublished).toBe(true);
    expect(pub.templateTagline).toBe("Paused tagline");
    expect(pub.templateDescription).toBe("Paused description");
    expect(pub.templateIcon).toBe("⏸️");
  });

  it("stamps the live template's icon onto managed agents (sidebar avatar glyph)", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "icon-live",
      icon: "✈️",
    });
    const { agent } = await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.id).toBe(agent.id);
    expect(pub.templateIcon).toBe("✈️");
  });

  it("omits templateIcon when the template has none — clients fall back to the first-letter placeholder", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "icon-less",
    });
    await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.templateIcon).toBeUndefined();
  });

  it("manual agents carry no templateIcon — nothing to annotate", async () => {
    await createAgent(
      {
        name: "Manual",
        description: "Hand-added agent",
        endpoint: "http://localhost:8000/agent",
        authMode: "none",
      },
      TEST_ORG,
    );
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.sourceTemplateId).toBeUndefined();
    expect(pub.templateIcon).toBeUndefined();
  });

  it("omits templateRequiredPlan for ungated templates", async () => {
    const template = await createTemplate({ ...validInput, slug: "ungated" });
    await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.templateRequiredPlan).toBeUndefined();
    expect(pub.templateUnpublished).toBeUndefined();
  });

  it("flags deactivated templates as unpublished (annotations ride along; the UI's chip precedence decides)", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "paused-gated",
      requiredPlan: "team",
      isActive: false,
    });
    await installTemplate(template, TEST_ORG);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.templateUnpublished).toBe(true);
    expect(pub.templateRequiredPlan).toBe("team");
  });

  it("tombstoned agents carry no annotations — Removed wins", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "tombstoned",
      requiredPlan: "pro",
    });
    await installTemplate(template, TEST_ORG);
    await deleteTemplate(template.id);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.templateRemovedAt).toBeTruthy();
    expect(pub.templateRequiredPlan).toBeUndefined();
    expect(pub.templateUnpublished).toBeUndefined();
  });

  it("tombstoned agents carry no live copy — the install-time row snapshot stands", async () => {
    const template = await createTemplate({
      ...validInput,
      slug: "copy-tombstoned",
      tagline: "Gone tagline",
      description: "Gone description",
      icon: "🧳",
    });
    await installTemplate(template, TEST_ORG);
    await deleteTemplate(template.id);
    const [pub] = await annotateAgentTemplateState(
      await listAgents(TEST_ORG),
    );
    expect(pub.templateRemovedAt).toBeTruthy();
    expect(pub.templateTagline).toBeUndefined();
    expect(pub.templateDescription).toBeUndefined();
    expect(pub.templateIcon).toBeUndefined();
  });
});

describe("getRunUsage (rolling 24h window)", () => {
  async function seedRun(opts: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    orgId?: string;
    ageHours: number;
  }) {
    await query(
      `INSERT INTO thread_metadata (thread_id, agent_id, user_id, org_id)
       VALUES ($1, $2, $3, $4)`,
      [opts.threadId, opts.agentId, opts.userId, opts.orgId ?? TEST_ORG],
    );
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, created_at)
       VALUES ($1, $2, now() - ($3 || ' hours')::interval)`,
      [opts.threadId, opts.runId, String(opts.ageHours)],
    );
  }

  it("counts runs joined via thread_metadata for the user + agent", async () => {
    await seedRun({ threadId: "t1", runId: "r1", userId: "u1", agentId: "a1", ageHours: 1 });
    await seedRun({ threadId: "t2", runId: "r2", userId: "u1", agentId: "a1", ageHours: 2 });
    const usage = await getRunUsage("u1", "a1");
    expect(usage.count).toBe(2);
    expect(usage.oldestAt).not.toBeNull();
  });

  it("excludes other users, other agents, and runs outside the window", async () => {
    await seedRun({ threadId: "t1", runId: "r1", userId: "u1", agentId: "a1", ageHours: 1 });
    // Different user.
    await seedRun({ threadId: "t2", runId: "r2", userId: "u2", agentId: "a1", ageHours: 1 });
    // Different agent.
    await seedRun({ threadId: "t3", runId: "r3", userId: "u1", agentId: "a2", ageHours: 1 });
    // Too old (25h > 24h window).
    await seedRun({ threadId: "t4", runId: "r4", userId: "u1", agentId: "a1", ageHours: 25 });
    const usage = await getRunUsage("u1", "a1");
    expect(usage.count).toBe(1);
  });

  it("returns zero + null oldest when there are no runs", async () => {
    const usage = await getRunUsage("nobody", "nothing");
    expect(usage.count).toBe(0);
    expect(usage.oldestAt).toBeNull();
  });

  it("honors a custom window size", async () => {
    await seedRun({ threadId: "t1", runId: "r1", userId: "u1", agentId: "a1", ageHours: 2 });
    expect((await getRunUsage("u1", "a1", 60 * 60 * 1000)).count).toBe(0);
    expect((await getRunUsage("u1", "a1", 3 * 60 * 60 * 1000)).count).toBe(1);
  });
});
