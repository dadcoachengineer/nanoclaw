import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow API requests to NanoClaw's system dashboard
  async rewrites() {
    return [
      {
        source: "/api/system/:path*",
        destination: "http://127.0.0.1:3939/api/:path*",
      },
    ];
  },
};

export default nextConfig;
