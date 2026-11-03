// A photo of the very aircraft, from planespotters.net (through /api/photo: their API answers
// servers only). Their terms: show the photographer's name and link to the photo's page.

export type Photo = { src: string; width: number; height: number; link: string; photographer: string };

const cache = new Map<string, Promise<Photo | null>>();

export function photoOf(hex: string): Promise<Photo | null> {
  let hit = cache.get(hex);
  if (!hit) {
    hit = fetch(`/api/photo?hex=${encodeURIComponent(hex)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { photo: Photo | null }).photo : null))
      .catch(() => null);
    cache.set(hex, hit);
  }
  return hit;
}
