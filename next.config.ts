import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  typedRoutes: true,
  async headers() {
    return [
      // The page asks for the microphone and the location, nothing else, and never inside a frame.
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: "microphone=(self), geolocation=(self), camera=()" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
