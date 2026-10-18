// Parking: the island-wide position catalog (built for GeoDeck 0.7 from OSM and
// city open data, 0.25° tiles under public/data/parking) plus live counts from
// TDX with the visitor's own key. A count is shown only while it is provably
// recent; otherwise the marker says "?" instead of guessing.

import { getJson } from "../lib/net";
import { freshness, type Freshness } from "../lib/time";
import { boundsOverlap, distance, inBounds, type Bounds, type Point } from "../lib/util";
import type { LiveLot } from "./tdx";

export const LIVE_MAX_AGE_MS = 5 * 60000;

export interface CatalogLot {
  id: string;
  lat: number;
  lng: number;
  name: string;
  kind: "lot" | "curb" | "space";
  total: number | null;
  rate: string | null;
  hours: string | null;
  address: string;
  access: string | null;
  source: string;
  url?: string;
}

interface TileMeta extends Bounds {
  id: string;
  file: string;
  count: number;
  lat: number;
  lng: number;
}

export interface CatalogIndex {
  fetchedAt: string;
  total: number;
  sources: Record<string, { name: string; url: string; license?: string }>;
  tiles: TileMeta[];
}

let index: Promise<CatalogIndex> | null = null;
const tiles = new Map<string, Promise<CatalogLot[]>>();

export function catalogIndex(): Promise<CatalogIndex> {
  index ??= getJson<CatalogIndex>("./data/parking/index.json").catch((e) => {
    index = null;
    throw e;
  });
  return index;
}

export async function catalogLots(view: Bounds): Promise<CatalogLot[]> {
  const meta = await catalogIndex();
  const needed = meta.tiles.filter((t) => boundsOverlap(t, view)).slice(0, 12);
  const parts = await Promise.all(
    needed.map((t) => {
      if (!tiles.has(t.id))
        tiles.set(
          t.id,
          getJson<CatalogLot[]>(`./data/parking/${t.file}`).catch((e) => {
            tiles.delete(t.id);
            throw e;
          }),
        );
      return tiles.get(t.id)!;
    }),
  );
  return parts.flat().filter((p) => inBounds(p, view));
}

/** Tile centroids with counts, for the zoomed-out overview. */
export async function catalogSummary(view: Bounds): Promise<Array<{ lat: number; lng: number; count: number }>> {
  const meta = await catalogIndex();
  return meta.tiles.filter((t) => boundsOverlap(t, view)).map((t) => ({ lat: t.lat, lng: t.lng, count: t.count }));
}

export interface ParkingStatus {
  label: string;
  state: Freshness | "full" | "none";
  text: string;
}

export function liveStatus(lot: Pick<LiveLot, "available" | "updatedAt" | "full">, now = Date.now()): ParkingStatus {
  if (lot.available === null) return { label: "?", state: "none", text: "來源沒有提供剩餘車位" };
  const f = freshness(lot.updatedAt, LIVE_MAX_AGE_MS, now);
  if (f === "unknown") return { label: "?", state: "unknown", text: `來源回報 ${lot.available} 格，但沒有資料時間，暫不採用` };
  if (lot.updatedAt! > now + 120000) return { label: "?", state: "unknown", text: "來源時間異常，暫不採用" };
  if (f === "stale") return { label: "?", state: "stale", text: `資料超過 5 分鐘（上次 ${lot.available} 格），暫不採用` };
  if (lot.available === 0 || lot.full) return { label: "滿", state: "full", text: "目前已滿" };
  return { label: String(lot.available), state: "fresh", text: `即時剩餘 ${lot.available} 格` };
}

/**
 * Live TDX lots and kerbside segments replace catalog entries of the same kind
 * within 60 m (the same place listed by both the city catalog and TDX);
 * everything else stays.
 */
export function mergeLots(catalog: CatalogLot[], live: LiveLot[]): { catalog: CatalogLot[]; live: LiveLot[] } {
  if (!live.length) return { catalog, live };
  const cell = (p: Point) => `${Math.floor(p.lat * 500)}:${Math.floor(p.lng * 500)}`;
  const grid = new Map<string, LiveLot[]>();
  for (const l of live) {
    const k = cell(l);
    grid.set(k, [...(grid.get(k) ?? []), l]);
  }
  const near = (p: CatalogLot) => {
    const la = Math.floor(p.lat * 500);
    const ln = Math.floor(p.lng * 500);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) for (const l of grid.get(`${la + i}:${ln + j}`) ?? []) if (l.kind === p.kind && distance(p, l) <= 60) return true;
    return false;
  };
  return { catalog: catalog.filter((p) => p.kind === "space" || !near(p)), live };
}

export function kindLabel(kind: CatalogLot["kind"]): string {
  return kind === "curb" ? "路邊停車" : kind === "space" ? "個別車格" : "停車場";
}

// ---- Where I parked --------------------------------------------------------

export interface ParkedCar extends Point {
  savedAt: number;
  note: string;
}
