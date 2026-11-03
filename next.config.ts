import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  typedRoutes: true,
  // The link preview reads its fonts from disk: ship them with its routes, and only them.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./assets/fonts/**/*"],
    "/twitter-image": ["./assets/fonts/**/*"],
  },
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
