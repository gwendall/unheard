"use client";

import { useEffect, useState } from "react";
import { PlaceMap } from "@/components/PlaceMap";
import { useI18n } from "@/components/I18n";
import { nearestPlace, placeLabel } from "@/lib/client/places";
import type { Guess } from "@/lib/client/where.worker";

/** A pass of a plane, made up: a straight line, metres east and north of the guess, with a bend. */
function pass(hex: string, from: [number, number], to: [number, number]) {
  const points: [number, number][] = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32;
    const bend = Math.sin(t * Math.PI) * 400;
    return [Math.round(from[0] + (to[0] - from[0]) * t + bend), Math.round(from[1] + (to[1] - from[1]) * t - bend / 2)];
  });
  const closest = points.reduce((a, b) => (Math.hypot(...b) < Math.hypot(...a) ? b : a));
  return { hex, points, closest };
}

const plane = (hex: string, registration: string, metres: number, at: number) => ({ hex, registration, type: "Cessna 172", metres, at, tone: 90 });

const SCENES: Record<string, { guess: Guess; others: { lat: number; lon: number }[] }> = {
  // The real recording's spot, 185 m from the truth, with passes in the shape of what it heard.
  oyster: {
    guess: {
      lat: 40.8748,
      lon: -73.5249,
      start: 1_778_900_000,
      mirror: { lat: 40.8886, lon: -73.5041 },
      planes: [plane("a1b2c3", "N172OB", 1400, 1_778_900_060), plane("c0ffee", "N4521K", 3100, 1_778_900_190)],
      paths: [pass("a1b2c3", [-9000, -5200], [8000, 6300]), pass("c0ffee", [7000, -8200], [-2500, 9100])],
    },
    others: [
      { lat: 40.8309, lon: -73.5801 },
      { lat: 40.9102, lon: -73.4603 },
      // Far along the coast: it may or may not fit, and its name must never be cut by the edge.
      { lat: 40.8601, lon: -73.3302 },
    ],
  },
  // A dense city, where the marks must hold their own among the names.
  city: {
    guess: {
      lat: 48.8606,
      lon: 2.3376,
      start: 1_778_900_000,
      mirror: null,
      planes: [plane("abc123", "F-GKXN", 900, 1_778_900_060)],
      paths: [pass("abc123", [-3500, -1200], [3000, 1800])],
    },
    others: [],
  },
  // An empty desert, where the map has nearly nothing to say.
  desert: {
    guess: {
      lat: 24.5,
      lon: 8.1,
      start: 1_778_900_000,
      mirror: { lat: 24.54, lon: 8.16 },
      planes: [plane("3c6444", "D-ABYA", 2400, 1_778_900_060), plane("4ca7b1", "EI-DWF", 3800, 1_778_900_190)],
      paths: [pass("3c6444", [-14_000, -9000], [13_000, 11_000]), pass("4ca7b1", [12_000, -12_000], [-6000, 14_000])],
    },
    others: [{ lat: 24.42, lon: 8.03 }],
  },
};

export function PlaceMapDemo({ scene, archive }: { scene?: string; archive?: string }) {
  const { locale } = useI18n();
  const { guess, others } = SCENES[scene ?? "oyster"] ?? SCENES.oyster;
  const [name, setName] = useState("");
  useEffect(() => {
    void nearestPlace(guess.lat, guess.lon, { locale }).then((place) => setName(place ? placeLabel(place) : ""));
  }, [guess, locale]);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pt-10 pb-16 sm:px-8">
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl" data-testid="place-name">
        {name || " "}
      </h1>
      {/* As the page holds it: half the width from `lg`. */}
      <div className="grid gap-8 lg:grid-cols-2">
        <PlaceMap guess={guess} others={others} archive={archive} />
      </div>
    </main>
  );
}
