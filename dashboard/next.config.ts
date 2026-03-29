import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN devices to access dev server
  allowedDevOrigins: ["local-ip", "dashboard.shearer.live"],
  // Allow API requests to NanoClaw's system dashboard
  async rewrites() {
    return [
      {
        source: "/api/system/:path*",
        destination: `http://127.0.0.1:${process.env.NANOCLAW_API_PORT || "3939"}/api/:path*`,
      },
    ];
  },
  serverExternalPackages: ["child_process", "better-sqlite3"],
  outputFileTracingRoot: import.meta.dirname,
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
