import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * The `details` payload of the standard 400 "Validation failed" response.
 * Deliberately the legacy `flatten()` shape — it is client-consumed
 * (catalog-admin, builder-config, connectors-admin) and asserted by the
 * route tests, so switching to the `treeifyError()` tree would break the
 * wire contract. Nested paths collapse to their first segment, the same
 * aggregation the deprecated `flatten()` performed.
 */
export type ValidationDetails = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

/**
 * One node of the `z.treeifyError()` tree. Structural (the exported type is
 * generic over the parsed output and degrades to `{ errors }` for
 * `unknown`); array `items` carry `null` for non-failing indices.
 */
type ErrorTree = {
  errors: string[];
  properties?: Record<string, ErrorTree>;
  items?: (ErrorTree | null)[];
};

/**
 * Map the `z.treeifyError()` tree back onto the `flatten()` wire shape.
 * `ZodError.flatten()` is deprecated in zod 4 in favor of the top-level
 * `z.treeifyError()`, but the tree keeps full paths where `flatten()` keyed
 * every issue by its FIRST path segment — so the map walks the tree and
 * aggregates each node's messages under its root segment. Root-level
 * issues (no path) stay in `formErrors`.
 */
export function validationErrorDetails(error: z.ZodError): ValidationDetails {
  const tree: ErrorTree = z.treeifyError(error);
  const fieldErrors: Record<string, string[]> = {};
  const walk = (node: ErrorTree, path: string[]): void => {
    if (node.errors.length > 0 && path.length > 0) {
      const key = path[0];
      (fieldErrors[key] ??= []).push(...node.errors);
    }
    for (const [segment, child] of Object.entries(node.properties ?? {})) {
      walk(child, [...path, segment]);
    }
    for (const [index, child] of (node.items ?? []).entries()) {
      if (child) walk(child, [...path, index.toString()]);
    }
  };
  walk(tree, []);
  return { formErrors: tree.errors, fieldErrors };
}

/**
 * The standard 400 response for a zod-validated request body —
 * `{ error: "Validation failed", details: <flatten-shaped field errors> }`.
 */
export function validationFailedResponse(error: z.ZodError): NextResponse {
  return NextResponse.json(
    { error: "Validation failed", details: validationErrorDetails(error) },
    { status: 400 },
  );
}
