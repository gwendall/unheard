import { notFound } from "next/navigation";

// The map on made-up flights, to look at it and for e2e/place-map.spec.ts. In development, and on
// a Vercel preview to check the real build's bundling: in production this is a 404.

export default async function DevMap({ searchParams }: { searchParams: Promise<{ scene?: string; archive?: string }> }) {
  if (process.env.NODE_ENV !== "development" && process.env.VERCEL_ENV !== "preview") notFound();
  const { PlaceMapDemo } = await import("@/components/PlaceMapDemo");
  const { scene, archive } = await searchParams;
  return <PlaceMapDemo scene={scene} archive={archive} />;
}
