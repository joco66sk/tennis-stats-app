import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    '*': ['./cache/**', './app/api/cache/**'],
  },
};

export default nextConfig;
