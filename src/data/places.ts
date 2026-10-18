// Saved places, search and handing a destination to a navigation app.

import { getJson } from "../lib/net";
import { read, write } from "../lib/store";
import { parseCoordinates, validPoint, type Point } from "../lib/util";
import type { ParkedCar } from "./parking";

export interface Place extends Point {
  title: string;
  subtitle?: string;
  country?: string;
  /** Google place id when the place came from Google search. */
  googleId?: string;
  /** Where the result came from, shown in search results. */
  source?: string;
}

export interface SavedPlace extends Place {
  id: string;
  note: string;
  savedAt: number;
}

const SAVED = "gdg.saved.v1";
const CAR = "gdg.car.v1";

export function savedPlaces(): SavedPlace[] {
  const rows = read<SavedPlace[]>(SAVED, []);
  return Array.isArray(rows) ? rows.filter((p) => validPoint(p) && typeof p.title === "string") : [];
}

export function savePlace(p: Place, note = ""): SavedPlace[] {
  const rows = savedPlaces();
  const id = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const next = [{ ...p, id, note, savedAt: Date.now() }, ...rows.filter((r) => r.id !== id)].slice(0, 300);
  write(SAVED, next);
  return next;
}

export function updatePlace(id: string, patch: Partial<Pick<SavedPlace, "title" | "note">>): SavedPlace[] {
  const next = savedPlaces().map((r) => (r.id === id ? { ...r, ...patch } : r));
  write(SAVED, next);
  return next;
}

export function removePlace(id: string): SavedPlace[] {
  const next = savedPlaces().filter((r) => r.id !== id);
  write(SAVED, next);
  return next;
}

export function isSaved(p: Point): SavedPlace | undefined {
  const id = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  return savedPlaces().find((r) => r.id === id);
}

export function parkedCar(): ParkedCar | null {
  const c = read<ParkedCar | null>(CAR, null);
  return validPoint(c) ? c : null;
}

export function setParkedCar(c: ParkedCar | null): void {
  write(CAR, c);
}

export function exportBackup(): string {
  return JSON.stringify({ app: "geodeck-globe", version: 1, saved: savedPlaces(), car: parkedCar() }, null, 2);
}

export function importBackup(text: string): number {
  const d = JSON.parse(text) as { saved?: SavedPlace[]; car?: ParkedCar | null };
  const incoming = (d.saved ?? []).filter((p) => validPoint(p) && typeof p.title === "string");
  const byId = new Map(savedPlaces().map((p) => [p.id, p]));
  for (const p of incoming) byId.set(p.id ?? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, { ...p, note: p.note ?? "", savedAt: p.savedAt ?? Date.now() });
  write(SAVED, [...byId.values()]);
  if (d.car && validPoint(d.car)) setParkedCar(d.car);
  return incoming.length;
}

// ---- Search ----------------------------------------------------------------

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
}

export function parsePhoton(d: { features?: PhotonFeature[] }): Place[] {
  const out: Place[] = [];
  for (const f of d.features ?? []) {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const p = f.properties ?? {};
    const place = { lat, lng } as Point;
    if (!validPoint(place)) continue;
    const title = p.name || [p.street, p.housenumber].filter(Boolean).join(" ") || "地圖位置";
    out.push({
      ...place,
      title,
      subtitle: [p.country, p.state, p.city || p.county, p.district, p.street].filter(Boolean).join(" "),
      country: (p.countrycode ?? "").toUpperCase(),
    });
  }
  return out;
}

export interface SearchResult {
  places: Place[];
  /** Why Google results are missing, when a Google key is set but failed. */
  googleError?: string;
}

/**
 * Coordinates, then saved places, then Google (when the visitor set their own
 * key) and OpenStreetMap side by side, Google first.
 */
export async function searchPlaces(
  text: string,
  near: Point | null,
  signal?: AbortSignal,
  google?: (q: string, near: Point | null) => Promise<Place[]>,
): Promise<SearchResult> {
  const q = text.trim();
  const coords = parseCoordinates(q);
  if (coords) return { places: [{ ...coords, title: q }] };
  if (!q) return { places: [] };
  const local = savedPlaces()
    .filter((p) => p.title.includes(q) || p.note.includes(q))
    .map((p) => ({ ...p, source: "收藏" }));
  const params = new URLSearchParams({ q, limit: "8" });
  if (near) {
    params.set("lat", near.lat.toFixed(3));
    params.set("lon", near.lng.toFixed(3));
  }
  const [g, osm] = await Promise.allSettled([
    google ? google(q, near) : Promise.resolve([]),
    getJson(`https://photon.komoot.io/api/?${params}`, { signal, timeout: 12000 }).then((d) => parsePhoton(d as { features?: PhotonFeature[] })),
  ]);
  const fromGoogle = g.status === "fulfilled" ? g.value : [];
  const fromOsm = (osm.status === "fulfilled" ? osm.value : []).map((p) => ({ ...p, source: "OpenStreetMap" }));
  if (!fromGoogle.length && !fromOsm.length && osm.status === "rejected" && (!google || g.status === "rejected")) throw osm.reason;
  // Drop OSM hits that are the same spot Google already returned.
  const dup = (p: Place) => fromGoogle.some((x) => Math.abs(x.lat - p.lat) < 0.0006 && Math.abs(x.lng - p.lng) < 0.0006);
  return {
    places: [...local, ...fromGoogle, ...fromOsm.filter((p) => !dup(p))],
    googleError: google && g.status === "rejected" ? (g.reason as Error).message : undefined,
  };
}

export function googleSearchUrl(text: string): string {
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: text })}`;
}

// ---- Navigation hand-off ---------------------------------------------------

export type NavApp = "google" | "apple" | "naver" | "waze";

export const NAV_APPS: Record<NavApp, string> = {
  google: "Google 地圖",
  apple: "Apple 地圖",
  naver: "NAVER Map（韓國）",
  waze: "Waze",
};

export type TravelMode = "driving" | "walking" | "transit";

export function navigationUrl(app: NavApp, dest: Place, mode: TravelMode = "driving"): string {
  const ll = `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`;
  switch (app) {
    case "apple":
      return `https://maps.apple.com/?${new URLSearchParams({ daddr: ll, dirflg: mode === "walking" ? "w" : mode === "transit" ? "r" : "d" })}`;
    case "naver": {
      const kind = mode === "transit" ? "public" : mode === "walking" ? "walk" : "car";
      const q = new URLSearchParams({ dlat: String(dest.lat), dlng: String(dest.lng), dname: dest.title || "目的地", appname: "geodeck.globe" });
      return `nmap://route/${kind}?${q}`;
    }
    case "waze":
      return `https://waze.com/ul?${new URLSearchParams({ ll, navigate: "yes" })}`;
    default: {
      // A Google place id opens the actual venue (hours, reviews) in Google Maps.
      const q = new URLSearchParams({ api: "1", destination: dest.googleId ? dest.title : ll, travelmode: mode });
      if (dest.googleId) q.set("destination_place_id", dest.googleId);
      return `https://www.google.com/maps/dir/?${q}`;
    }
  }
}

/** Korea's map data is restricted for Google; NAVER is what locals use there. */
export function defaultNavApp(dest: Place, preference: NavApp | "auto"): NavApp {
  if (preference !== "auto") return preference;
  const inKorea = dest.country === "KR" || (dest.lat > 33 && dest.lat < 38.7 && dest.lng > 124.5 && dest.lng < 131);
  return inKorea ? "naver" : "google";
}
