import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained .next/standalone/ directory with a minimal
  // server.js — smaller Docker image, no need to copy all of node_modules.
  // Migration SQL files are copied separately in the Dockerfile.
  output: "standalone",
};

export default nextConfig;
