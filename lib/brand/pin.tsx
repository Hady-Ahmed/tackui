import type { ReactElement } from "react";

/**
 * TackUI brand glyph — a 3D thumbtack/pin on a blue gradient chip.
 *
 * The geometry mirrors {@link ../../../app/icon.svg} (the static favicon) so
 * the generated apple-touch / social-share images stay in lockstep with the
 * browser-tab icon. Update both when tweaking the silhouette.
 *
 * Rendered via Satori (`next/og` `ImageResponse`), which supports a subset of
 * SVG — `<rect>`, `<ellipse>`, `<path>` with presentation attributes and
 * inline `<defs>` gradients. Satori does NOT support CSS `<style>` blocks or
 * `filter`, so the dark-mode brightness boost from the static favicon is not
 * replicated here (the generated images always use the light-mode palette).
 *
 * @param size - square edge length in pixels
 */
export function PinMark({ size = 128 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="pin-chip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
        <radialGradient id="pin-dome" cx="0.3" cy="0.2" r="0.9">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="35%" stopColor="#f0f7ff" />
          <stop offset="75%" stopColor="#a5c8f5" />
          <stop offset="100%" stopColor="#5b8fc9" />
        </radialGradient>
        <linearGradient id="pin-needle" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="50%" stopColor="#f1f5f9" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="32" height="32" rx="7" fill="url(#pin-chip)" />
      <path d="M14.5 11 L17.5 11 L16 27 Z" fill="url(#pin-needle)" />
      <ellipse cx="16" cy="8.5" rx="8" ry="6" fill="url(#pin-dome)" />
      <ellipse cx="13" cy="6.3" rx="3" ry="1.6" fill="#ffffff" opacity="0.8" />
    </svg>
  );
}

/**
 * Full 1200×630 social-share card (Open Graph + Twitter).
 *
 * Dark canvas with a blue radial glow echoing the landing-page hero
 * (`components/landing.tsx` `pulse-glow`), centered logo mark, wordmark, and
 * tagline. Every multi-child `<div>` declares `display: flex` — Satori
 * requirement (it does not infer block layout).
 */
export function OgCard(): ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        backgroundColor: "#09090b",
        fontFamily: "sans-serif",
      }}
    >
      {/* radial blue glow — simulates the landing hero's blur without filter:blur */}
      <div
        style={{
          position: "absolute",
          top: "-140px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "900px",
          height: "520px",
          display: "flex",
          background:
            "radial-gradient(ellipse at center, rgba(59,130,246,0.30) 0%, rgba(59,130,246,0) 60%)",
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "30px",
        }}
      >
        <PinMark size={132} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              color: "#ffffff",
              fontSize: "78px",
              fontWeight: 700,
              letterSpacing: "-2px",
            }}
          >
            TackUI
          </div>
          <div
            style={{
              display: "flex",
              color: "#a1a1aa",
              fontSize: "27px",
            }}
          >
            Unified agent frontend for AG-UI agents
          </div>
        </div>
      </div>
    </div>
  );
}
