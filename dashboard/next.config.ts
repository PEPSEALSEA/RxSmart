import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/RxSmart",
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
