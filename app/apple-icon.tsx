import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/AppIcon";

// The iPhone home-screen icon: iOS rounds the corners itself.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={180} />, size);
}
