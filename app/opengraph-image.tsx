import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/OgCard";

// The link preview of every page: static, drawn once at build. No place, no time, no user data.
export const alt = "There's a plane you can't hear. Your phone hears it. Unheard names it. A glowing amber tone bends down across a night-blue spectrogram, as the pitch of a passing plane does.";
export const size = OG_SIZE;
export const contentType = "image/png";

const FONTS = join(process.cwd(), /* turbopackIgnore: true */ "assets/fonts");

export default async function Image() {
  const [semibold, medium, mono] = await Promise.all(["Geist-600.ttf", "Geist-500.ttf", "GeistMono-500.ttf"].map((f) => readFile(join(FONTS, f))));
  return new ImageResponse(<OgCard />, {
    ...size,
    fonts: [
      { name: "Geist", data: semibold, weight: 600, style: "normal" },
      { name: "Geist", data: medium, weight: 500, style: "normal" },
      { name: "GeistMono", data: mono, weight: 500, style: "normal" },
    ],
  });
}
