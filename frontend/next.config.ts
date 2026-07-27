import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@chains/game-core"],
  turbopack: {
    // Monorepo-style layout (packages/game-core is linked via file:) — pin the
    // workspace root to the repo root so Next doesn't guess from stray lockfiles.
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
