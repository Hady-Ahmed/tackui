"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Clamp long text to N lines with a "Show more / Show less" toggle that
 * appears only when the text actually overflows. Used by the catalog
 * cards (both /app/catalog and the public /catalog marketing page) so a
 * 2000-char description can't stretch a card into a giant uneven row.
 *
 * The toggle is client-only: the server (public /catalog is a server
 * component) renders the clamped <p>, hydration measures real overflow
 * and adds the button — so no mismatch, and cards without long text
 * never render a control.
 *
 * Overflow detection compares scrollHeight vs clientHeight while the
 * clamp is applied (on mount, on element resize, and after web fonts
 * load — a late font swap rewraps text without resizing the clamped
 * box). Once expanded the toggle sticks: re-measuring while expanded
 * can't see the collapsed height without a hidden clone, and the text
 * was overflowing when collapsed by definition.
 */
export function ExpandableText({
  text,
  lines,
  className,
}: {
  text: string;
  /** Max visible lines while collapsed (line-clamp). */
  lines: number;
  /** Styling for the text itself (size, weight, color). */
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // "Expanded" is keyed to the text itself: when fresh copy arrives
  // (live propagation refresh), the card automatically re-collapses —
  // no stale Show-less toggle on short text and no effect-based reset.
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // Late font swap changes wrapping without changing the clamped
    // box's own size — the element ResizeObserver can't catch it.
    document.fonts?.ready.then(measure).catch(() => {});
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, text]);

  return (
    <>
      <p
        ref={ref}
        className={className}
        style={
          expanded
            ? undefined
            : {
                display: "-webkit-box",
                WebkitLineClamp: lines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
        }
      >
        {text}
      </p>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpandedText(expanded ? null : text)}
          className="mt-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
