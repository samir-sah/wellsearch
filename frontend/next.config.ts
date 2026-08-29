import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: projectRoot,
  turbopack: { root: projectRoot },
};

export default nextConfig;
