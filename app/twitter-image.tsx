import { ImageResponse } from "next/og";
import { OgCard } from "@/lib/brand/pin";

export const alt = "TackUI — Unified agent frontend for AG-UI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Twitter / X card image — X does not read `og:image`, it needs its own
 * `twitter:image` meta tag, which Next.js auto-injects from this file
 * convention. Reuses the same {@link OgCard} art as the OG image for parity.
 */
export default function Image() {
  return new ImageResponse(<OgCard />, { ...size });
}
