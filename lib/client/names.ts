// What people call an aircraft: "easyJet EC4586, Lanzarote to Paris" or "Cessna 172 Skyhawk of the
// Aéroclub de Toussus", not "EJU4586" or "F-GDEM". The facts come from adsbdb.com, asked from the
// phone (it answers any origin), once per aircraft and per callsign. Only aircraft codes are sent,
// never the listener's position.

import type { AircraftMeta } from "../adsb";
import { aircraftType } from "./types";
import { nameOf } from "./format";

const API = "https://api.adsbdb.com/v0";

export type Place = { city: string; code: string; lat: number; lon: number };

export type Route = { airline: string; flight: string; from: Place; to: Place };

export type Airframe = { model: string; owner: string | null; registration: string | null };

export type Identity = {
  /** What the title is: a flight, the model of the aircraft, or only its callsign. */
  kind: "flight" | "model" | "callsign";
  /** The headline name: "easyJet EC4586", "Cessna 172 Skyhawk", else the callsign. */
  title: string;
  /** What it is, without the headline: "Airbus A320neo, F-HBXA" or "F-GDEM, Aéroclub de Toussus". */
  detail: string;
  /** Where it flies from and to, when the route is known and fits where the aircraft is. */
  route: Route | null;
};

type AdsbdbAircraft = { type?: string; icao_type?: string; manufacturer?: string; registration?: string; registered_owner?: string };
type AdsbdbAirport = { municipality?: string; iata_code?: string; icao_code?: string; latitude?: number; longitude?: number };
type AdsbdbRoute = { callsign_iata?: string; airline?: { name?: string } | null; origin?: AdsbdbAirport; destination?: AdsbdbAirport };

const cache = new Map<string, Promise<unknown>>();

async function ask<T>(path: string, pick: (response: unknown) => T | null): Promise<T | null> {
  let hit = cache.get(path) as Promise<T | null> | undefined;
  if (!hit) {
    hit = fetch(`${API}/${path}`)
      .then(async (res) => (res.ok ? pick(((await res.json()) as { response?: unknown }).response) : null))
      .catch(() => null);
    cache.set(path, hit);
  }
  return hit;
}

const place = (a?: AdsbdbAirport): Place | null =>
  a?.municipality && typeof a.latitude === "number" && typeof a.longitude === "number"
    ? { city: a.municipality, code: a.iata_code || a.icao_code || "", lat: a.latitude, lon: a.longitude }
    : null;

/** An airline-looking callsign: three letters then a flight number ("EJU4586", "AFR12KP"). */
export const isAirlineCallsign = (callsign?: string) => !!callsign && /^[A-Z]{3}\d[A-Z0-9]{0,4}$/.test(callsign);

export async function routeOf(callsign: string): Promise<Route | null> {
  return ask(`callsign/${encodeURIComponent(callsign)}`, (r) => {
    const fr = (r as { flightroute?: AdsbdbRoute } | null)?.flightroute;
    const from = place(fr?.origin);
    const to = place(fr?.destination);
    if (!fr || !from || !to) return null;
    return { airline: fr.airline?.name?.trim() || "", flight: fr.callsign_iata || callsign, from, to };
  });
}

export async function airframeOf(hex: string): Promise<Airframe | null> {
  return ask(`aircraft/${encodeURIComponent(hex)}`, (r) => {
    const a = (r as { aircraft?: AdsbdbAircraft } | null)?.aircraft;
    if (!a) return null;
    const model = [a.manufacturer, a.type].filter(Boolean).join(" ").trim();
    return { model, owner: a.registered_owner?.trim() || null, registration: a.registration || null };
  });
}

const rad = Math.PI / 180;
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const s = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(s));
}

/**
 * Whether a route fits an aircraft seen at this position: a callsign's published route can be
 * stale or reused, and a wrong "Paris to Nice" is worse than none. The detour through the aircraft
 * may be at most 30 % longer than the direct leg, plus 150 km for climbs, holds and approaches.
 */
export function routeFits(route: Route, at: { lat: number; lon: number }): boolean {
  const direct = distanceKm(route.from, route.to);
  return distanceKm(route.from, at) + distanceKm(at, route.to) <= direct * 1.3 + 150;
}

/** The airline name as people say it: no "System", "Airlines", "S.A." tails when the rest is clear. */
export function airlineName(name: string): string {
  const short = name.replace(/\b(Airlines? System|Airways? Ltd|S\.?A\.?|Ltd\.?|Inc\.?|Company)\b\.?/gi, "").replace(/\s+/g, " ").trim();
  return short || name;
}

/** The identity from what is known so far: always something, better once the lookups answer. */
export function identityOf(meta: AircraftMeta, frame: Airframe | null, route: Route | null): Identity {
  const listed = aircraftType(meta.type);
  const model = listed && listed.name !== meta.type?.toUpperCase() ? listed.name : frame?.model || listed?.name || "";
  const registration = meta.registration || frame?.registration || null;
  if (route) {
    const airline = airlineName(route.airline);
    return {
      kind: "flight",
      title: [airline, route.flight].filter(Boolean).join(" "),
      detail: [model, registration].filter(Boolean).join(", "),
      route,
    };
  }
  if (model && !isAirlineCallsign(meta.callsign)) {
    const owner = frame?.owner && frame.owner !== registration ? frame.owner : null;
    return { kind: "model", title: model, detail: [registration, owner].filter(Boolean).join(", "), route: null };
  }
  return { kind: "callsign", title: nameOf(meta), detail: [model, registration !== nameOf(meta) ? registration : null].filter(Boolean).join(", "), route: null };
}

/** Looks an aircraft up (both lookups at once) and returns its identity. Never throws. */
export async function lookUp(meta: AircraftMeta, at: { lat: number; lon: number } | null): Promise<Identity> {
  const [frame, route] = await Promise.all([airframeOf(meta.hex), isAirlineCallsign(meta.callsign) ? routeOf(meta.callsign!) : Promise.resolve(null)]);
  return identityOf(meta, frame, route && (!at || routeFits(route, at)) ? route : null);
}

/** The identity as the end of a sentence: "a Cessna 172 Skyhawk", "an Airbus H135", "easyJet EC4586". */
export function spoken(id: Identity): string {
  if (id.kind !== "model") return id.title;
  return `${/^[aeiou]/i.test(id.title) ? "an" : "a"} ${id.title}`;
}
