import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple Touch Icon — iOS / iPadOS home-screen bookmark tile.
 *
 * Generated as a 180×180 PNG via Satori. Fills the full square with the blue
 * gradient chip (no rounded corners — iOS applies its own mask) and centers
 * the 3D thumbtack glyph oversized so it reads on the small springboard grid.
 */
export default function AppleIcon() {
  return new ImageResponse(
    <svg width={180} height={180} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="apple-chip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
        <radialGradient id="apple-dome" cx="0.3" cy="0.2" r="0.9">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="35%" stopColor="#f0f7ff" />
          <stop offset="75%" stopColor="#a5c8f5" />
          <stop offset="100%" stopColor="#5b8fc9" />
        </radialGradient>
        <linearGradient id="apple-needle" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="50%" stopColor="#f1f5f9" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="32" height="32" fill="url(#apple-chip)" />
      <path d="M14.5 11 L17.5 11 L16 27 Z" fill="url(#apple-needle)" />
      <ellipse cx="16" cy="8.5" rx="8" ry="6" fill="url(#apple-dome)" />
      <ellipse cx="13" cy="6.3" rx="3" ry="1.6" fill="#ffffff" opacity="0.8" />
    </svg>,
    { ...size }
  );
}
