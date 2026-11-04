import type { MetadataRoute } from "next";

// Lets a phone keep Unheard on its home screen, opening full screen on the bare address (which
// answers in the phone's language).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Unheard",
    short_name: "Unheard",
    description: "Where was this filmed? The planes in its sound can sometimes tell.",
    start_url: "/",
    display: "standalone",
    background_color: "#05070d",
    theme_color: "#05070d",
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
