import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/AppIcon";

// The tab icon and the home-screen icons the manifest lists, drawn once at build.
export const contentType = "image/png";
const SIZES = [32, 192, 512];

export function generateImageMetadata() {
  return SIZES.map((s) => ({ id: String(s), size: { width: s, height: s }, contentType }));
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const size = Number(await id);
  return new ImageResponse(<AppIcon size={size} />, { width: size, height: size });
}
