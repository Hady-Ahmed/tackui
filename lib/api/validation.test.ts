import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  validationErrorDetails,
  validationFailedResponse,
} from "./validation";

/**
 * The helper's contract: reproduce the deprecated `ZodError.flatten()`
 * wire shape exactly (the route 400 responses' `details` payload is
 * client-consumed), built from the non-deprecated `z.treeifyError()`.
 * Every shape test asserts equality against the deprecated API's own
 * output — the most direct proof the map is faithful.
 */
function assertMatchesFlatten(schema: z.ZodType, input: unknown): void {
  const parsed = schema.safeParse(input);
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(validationErrorDetails(parsed.error)).toEqual(parsed.error.flatten());
  }
}

describe("validationErrorDetails", () => {
  it("maps flat field errors to the flatten() wire shape", () => {
    const schema = z.object({ name: z.string(), title: z.string().min(1) });
    assertMatchesFlatten(schema, { name: 1, title: "" });
  });

  it("aggregates nested-path issues under the first path segment (flatten()'s behavior)", () => {
    const schema = z.object({
      parent: z.object({ child: z.string(), other: z.string() }),
    });
    assertMatchesFlatten(schema, { parent: { child: 1, other: 2 } });
  });

  it("maps array-item issues under the array field's name", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    assertMatchesFlatten(schema, { tags: ["ok", 1, 2] });
  });

  it("maps root-level refine issues to formErrors", () => {
    const schema = z
      .object({ seats: z.number() })
      .refine((d) => d.seats >= 2, { error: "Team plan requires at least 2 seats." });
    assertMatchesFlatten(schema, { seats: 1 });
  });

  it("keeps path on refine issues that declare one", () => {
    const schema = z
      .object({ seats: z.number() })
      .refine((d) => d.seats >= 2, { error: "Team plan requires at least 2 seats.", path: ["seats"] });
    assertMatchesFlatten(schema, { seats: 1 });
  });

  it("collects multiple errors on one field in issue order", () => {
    const schema = z.object({
      slug: z.string().min(3).max(10).regex(/^[a-z]+$/),
    });
    assertMatchesFlatten(schema, { slug: "ab" });
  });

  it("splits root issues (formErrors) from field issues (fieldErrors)", () => {
    const schema = z
      .object({ name: z.string().min(1) })
      .refine((d) => d.name !== "x", { error: "name is reserved" });
    assertMatchesFlatten(schema, { name: "x" });
  });

  it("handles custom issues pushed with an explicit path (superRefine)", () => {
    const schema = z.object({ a: z.string() }).superRefine((val, ctx) => {
      ctx.addIssue({
        code: "custom",
        path: ["a"],
        message: "custom issue",
      });
    });
    assertMatchesFlatten(schema, { a: "" });
  });

  it("returns empty collections for an error with no issues", () => {
    const empty = new z.ZodError([]);
    expect(validationErrorDetails(empty)).toEqual(empty.flatten());
  });
});

describe("validationFailedResponse", () => {
  it("returns the standard 400 body with flatten()-shaped details", async () => {
    const schema = z.object({ name: z.string() });
    const parsed = schema.safeParse({ name: 1 });
    if (!parsed.success) {
      const res = validationFailedResponse(parsed.error);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    } else {
      throw new Error("expected schema failure");
    }
  });
});
