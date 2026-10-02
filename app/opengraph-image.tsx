import { ImageResponse } from "next/og";
import { OgCard } from "@/lib/brand/pin";

export const alt = "TackUI — Unified agent frontend for AG-UI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Open Graph image — rendered as the link-preview thumbnail on Slack,
 * Discord, iMessage, LinkedIn, Facebook, etc. Next.js auto-injects the
 * matching `<meta property="og:image">` tag from this file convention.
 */
export default function Image() {
  return new ImageResponse(<OgCard />, { ...size });
}
