import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tests live beside the code as *.test.ts; keep them out of the build graph.
  pageExtensions: ["ts", "tsx"],
  // The dev badge sits bottom-left, on top of the sidebar's last control.
  devIndicators: false,
};

export default nextConfig;
