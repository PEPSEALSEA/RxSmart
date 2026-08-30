import type { NextConfig } from "next";
import path from "node:path";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? (process.env.GITHUB_ACTIONS ? "/RxSmart" : undefined);

const nextConfig: NextConfig = {
  output: "export",
  ...(basePath ? { basePath } : {}),
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
