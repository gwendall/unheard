import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/OgCard";
import { DEFAULT_LOCALE, isLocale, messages } from "@/lib/i18n";

// The link preview of every page, in its language: static, drawn once per language at build. No
// place, no time, no user data.
export const contentType = "image/png";

// Next also calls this while listing the image's static params, without the language: one id
// either way, and the alt in English until the language is known.
export async function generateImageMetadata({ params }: { params?: { lang?: string } }) {
  const { meta } = await messages(isLocale(params?.lang) ? params.lang : DEFAULT_LOCALE);
  return [{ id: "card", alt: meta.ogAlt, size: OG_SIZE, contentType }];
}

const FONTS = join(process.cwd(), /* turbopackIgnore: true */ "assets/fonts");

export default async function Image({ params }: { params: Promise<{ lang: string }> }) {
  const lang = (await params)?.lang;
  const { og } = await messages(isLocale(lang) ? lang : DEFAULT_LOCALE);
  const [semibold, medium, mono] = await Promise.all(["Geist-600.ttf", "Geist-500.ttf", "GeistMono-500.ttf"].map((f) => readFile(join(FONTS, f))));
  return new ImageResponse(<OgCard lines={og.lines} sub={og.sub} size={og.size} />, {
    ...OG_SIZE,
    fonts: [
      { name: "Geist", data: semibold, weight: 600, style: "normal" },
      { name: "Geist", data: medium, weight: 500, style: "normal" },
      { name: "GeistMono", data: mono, weight: 500, style: "normal" },
    ],
  });
}
