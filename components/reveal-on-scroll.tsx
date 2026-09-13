"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scroll-triggered reveal wrapper — a small client island.
 *
 * Wraps children in a div that starts at opacity-0 + translate-y-6 and
 * transitions to opacity-100 + translate-y-0 when the element enters the
 * viewport (via IntersectionObserver). One-shot: disconnects after the
 * first intersection so the element never re-hides.
 *
 * Used by the landing page to stagger-reveal sections below the fold.
 * The hero section itself uses the CSS-only `animate-fade-in-up` class
 * (no JS needed for above-the-fold content).
 *
 * Fallback: if IntersectionObserver is unavailable (very old browsers),
 * the content is shown immediately.
 */
export function RevealOnScroll({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -50px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${
        visible
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-6"
      } ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
