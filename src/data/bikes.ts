// Bike share docks worldwide from CityBikes (api.citybik.es, open to browsers,
// no key): about 800 systems, YouBike in a dozen Taiwanese cities among them.
// The network list is read once a session; a network's stations once a minute
// while they are on screen.

import { getJson } from "../lib/net";
import { distance, inBounds, num, point, type Bounds, type Point } from "../lib/util";

const API = "https://api.citybik.es/v2";

export interface BikeNetwork extends Point {
  id: string;
  name: string;
  city: string;
  country: string;
}

export interface BikeStation extends Point {
  id: string;
  network: string;
  name: string;
  /** Bikes to rent now; null when the system does not say. */
  bikes: number | null;
  ebikes: number | null;
  /** Free docks to return a bike. */
  docks: number | null;
  slots: number | null;
  address: string;
  /** When CityBikes last read the system. */
  updatedAt: number | null;
  online: boolean;
}

interface RawNetwork {
  id?: string;
  name?: string;
  location?: { latitude?: number; longitude?: number; city?: string; country?: string };
}

export function parseNetworks(data: { networks?: RawNetwork[] }): BikeNetwork[] {
  return (data?.networks ?? []).flatMap((n) => {
    const p = point(n.location?.latitude, n.location?.longitude);
    return n.id && p ? [{ id: n.id, name: n.name ?? n.id, city: n.location?.city ?? "", country: n.location?.country ?? "", ...p }] : [];
  });
}

/** "2026-10-27T09:38:48.394932+00:00Z": an offset and a Z both; Date.parse wants one. */
export function bikeTime(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s.replace(/([+-]\d{2}:\d{2})Z$/, "$1"));
  return Number.isFinite(t) ? t : null;
}

interface RawStation {
  id?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  timestamp?: string;
  free_bikes?: number | null;
  empty_slots?: number | null;
  extra?: { address?: string; slots?: number; ebikes?: number; online?: boolean; renting?: number | boolean; installed?: boolean; en?: unknown };
}

export function parseStations(network: string, data: { network?: { stations?: RawStation[] } }): BikeStation[] {
  return (data?.network?.stations ?? []).flatMap((s) => {
    const p = point(s.latitude, s.longitude);
    if (!s.id || !p) return [];
    const x = s.extra ?? {};
    const online = x.online !== false && x.renting !== 0 && x.renting !== false && x.installed !== false;
    return [
      {
        id: `${network}:${s.id}`,
        network,
        name: (s.name ?? "").trim(),
        ...p,
        bikes: num(s.free_bikes),
        ebikes: num(x.ebikes),
        docks: num(s.empty_slots),
        slots: num(x.slots),
        address: typeof x.address === "string" ? x.address.trim() : "",
        updatedAt: bikeTime(s.timestamp),
        online,
      },
    ];
  });
}

let networks: Promise<BikeNetwork[]> | null = null;
export function bikeNetworks(): Promise<BikeNetwork[]> {
  networks ??= getJson<{ networks?: RawNetwork[] }>(`${API}/networks?fields=id,name,location`, { timeout: 20000 })
    .then(parseNetworks)
    .catch((e) => {
      networks = null;
      throw e;
    });
  return networks;
}

/**
 * Networks whose centre is within reach of the view. A system's stations
 * spread around its listed centre (YouBike Taipei covers the whole city),
 * so the view is widened by `reachKm` before matching; the nearest come first.
 */
export function networksNear(all: BikeNetwork[], view: Bounds, reachKm = 25, max = 3): BikeNetwork[] {
  const centre = { lat: (view.north + view.south) / 2, lng: (view.east + view.west) / 2 };
  const dLat = reachKm / 111;
  const dLng = reachKm / (111 * Math.max(0.2, Math.cos((centre.lat * Math.PI) / 180)));
  const wide = { north: view.north + dLat, south: view.south - dLat, east: view.east + dLng, west: view.west - dLng };
  return all
    .filter((n) => inBounds(n, wide))
    .sort((a, b) => distance(a, centre) - distance(b, centre))
    .slice(0, max);
}

const stations = new Map<string, { at: number; rows: Promise<BikeStation[]> }>();

/** One network's stations, re-read after a minute. */
export function networkStations(id: string, force = false): Promise<BikeStation[]> {
  const hit = stations.get(id);
  if (hit && Date.now() - hit.at < (force ? 30000 : 60000)) return hit.rows;
  const entry = {
    at: Date.now(),
    rows: getJson<{ network?: { stations?: RawStation[] } }>(`${API}/networks/${encodeURIComponent(id)}`, { timeout: 20000 }).then((d) => parseStations(id, d)),
  };
  stations.set(id, entry);
  entry.rows.catch(() => stations.get(id) === entry && stations.delete(id));
  return entry.rows;
}

/** Counts older than this are shown as "?" (CityBikes reads most systems every minute or two). */
export const BIKE_MAX_AGE_MS = 15 * 60000;

/** Bikes to rent as a map label: "?" when the count is missing or too old to trust. */
export function bikeCount(s: Pick<BikeStation, "bikes" | "updatedAt" | "online">, now = Date.now()): { label: string; state: "ok" | "low" | "empty" | "old" | "none" } {
  if (s.bikes === null) return { label: "?", state: "none" };
  if (s.updatedAt === null || now - s.updatedAt > BIKE_MAX_AGE_MS) return { label: "?", state: "old" };
  if (!s.online || s.bikes === 0) return { label: s.online ? "0" : "停", state: "empty" };
  return { label: String(s.bikes), state: s.bikes <= 2 ? "low" : "ok" };
}
