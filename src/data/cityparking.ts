// Live parking counts the cities publish themselves, readable without any
// key: Taipei, Taoyuan, Taichung and Tainan.
// With these, counts show for everyone; TDX (the visitor's own key) still
// covers other cities and kerbside segments. Every row carries the city's own
// update time and liveStatus judges it. Taoyuan and Taichung refresh within a
// minute or two, so the usual five minutes apply. Taipei publishes its file
// every five minutes and it lands two to three minutes late, and Tainan's lots
// report every four to six minutes (measured 2026-10-27), so for those two a
// count stays good for ten minutes: one missed cycle, not a guess.

import { getJson, getText } from "../lib/net";
import { parseTime } from "../lib/time";
import { num, point } from "../lib/util";
import type { CatalogLot } from "./parking";
import type { LiveLot } from "./tdx";
import { xmlText } from "./worldcams";

const SLOW_FEED_MAX_AGE_MS = 10 * 60000;

const lot = (city: string, source: LiveLot["source"], row: Omit<LiveLot, "kind" | "city" | "source" | "full">): LiveLot => ({
  ...row,
  kind: "lot",
  city,
  source,
  full: row.available === 0,
  ...(source === "taipei" || source === "tainan" ? { maxAgeMs: SLOW_FEED_MAX_AGE_MS } : {}),
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue Oct 27 17:40:00 CST 2026": CST here is Taiwan time (UTC+8), not US Central. */
export function taipeiTime(s: string): number | null {
  const m = s.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) CST (\d{4})$/);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]) - 8, Number(m[4]), Number(m[5]));
}

/** Taoyuan: XML with the update time on the root and lat/lng named the other way round (wgsX is latitude). */
export function parseTaoyuan(xml: string): LiveLot[] {
  const at = parseTime(xml.match(/<parkingLots[^>]*\bupdatetime="([^"]+)"/)?.[1]);
  const out: LiveLot[] = [];
  for (const [, b] of xml.matchAll(/<parkingLot>([\s\S]*?)<\/parkingLot>/g)) {
    const p = point(xmlText(b, "wgsX"), xmlText(b, "wgsY"));
    const id = xmlText(b, "parkId");
    if (!p || !id) continue;
    const free = num(xmlText(b, "surplusSpace"));
    out.push(
      lot("桃園市", "taoyuan", {
        id: `taoyuan-${id}`,
        name: xmlText(b, "parkName"),
        ...p,
        total: num(xmlText(b, "totalSpace")),
        available: free !== null && free >= 0 ? free : null,
        updatedAt: at,
        address: xmlText(b, "address"),
        fare: xmlText(b, "payGuide"),
      }),
    );
  }
  return out;
}

interface TaichungLot {
  ID?: string;
  Position?: string;
  X?: number;
  Y?: number;
  TotalCar?: number;
  AvailableCar?: number;
  Notes?: string;
  Updatetime?: string;
}
/** Taichung: lots grouped by area; only these (not the 1,400-lot list, which has a colour but no count) carry numbers. */
export function parseTaichung(groups: Array<{ ParkingLots?: TaichungLot[] }>): LiveLot[] {
  const out: LiveLot[] = [];
  for (const l of (Array.isArray(groups) ? groups : []).flatMap((g) => g.ParkingLots ?? [])) {
    const p = point(l.Y, l.X);
    if (!p || !l.ID) continue;
    const free = num(l.AvailableCar);
    out.push(
      lot("臺中市", "taichung", {
        id: `taichung-${l.ID}`,
        name: (l.Position ?? "").trim(),
        ...p,
        total: num(l.TotalCar),
        available: free !== null && free >= 0 ? free : null,
        updatedAt: parseTime(l.Updatetime),
        address: "",
        fare: (l.Notes ?? "").trim(),
      }),
    );
  }
  return out;
}

interface TainanLot {
  code?: string;
  name?: string;
  address?: string;
  car?: number | string;
  car_total?: number | string;
  chargeFee?: string;
  update_time?: string;
  lnglat?: string;
}
/** Tainan's parking site: "lnglat" is actually "lat,lng". */
export function parseTainan(rows: TainanLot[]): LiveLot[] {
  const out: LiveLot[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const [lat, lng] = (r.lnglat ?? "").split(",");
    const p = point(lat, lng);
    if (!p || !r.code) continue;
    const free = num(r.car);
    out.push(
      lot("臺南市", "tainan", {
        id: `tainan-web-${r.code}`,
        name: (r.name ?? "").trim(),
        ...p,
        total: num(r.car_total),
        available: free !== null && free >= 0 ? free : null,
        updatedAt: parseTime(r.update_time),
        address: (r.address ?? "").trim(),
        fare: (r.chargeFee ?? "").trim(),
      }),
    );
  }
  return out;
}

interface TaipeiCount {
  available: number | null;
  updatedAt: number | null;
}
/** Taipei's counts by lot id ("taipei-TPE0001"); joined to catalog positions at draw time. */
export function parseTaipeiCounts(xml: string): Map<string, TaipeiCount> {
  const at = taipeiTime(xmlText(xml.slice(0, 400), "UPDATETIME"));
  const out = new Map<string, TaipeiCount>();
  for (const [, b] of xml.matchAll(/<PARK>([\s\S]*?)<\/PARK>/g)) {
    const free = num(xmlText(b, "AVAILABLECAR"));
    // -9 means the lot does not report.
    out.set(`taipei-${xmlText(b, "ID")}`, { available: free !== null && free >= 0 ? free : null, updatedAt: at });
  }
  return out;
}

/** Taipei: counts only; positions, names and fares come from the catalog (same ids). */
export function joinTaipei(counts: Map<string, TaipeiCount>, catalog: CatalogLot[]): LiveLot[] {
  return catalog.flatMap((known) => {
    const c = known.kind === "lot" ? counts.get(known.id) : undefined;
    return c
      ? [lot("臺北市", "taipei", { id: known.id, name: known.name, lat: known.lat, lng: known.lng, total: known.total, ...c, address: known.address, fare: known.rate ?? "" })]
      : [];
  });
}

interface Feed<T> {
  name: string;
  fetch: () => Promise<T>;
  join: (raw: T, catalog: CatalogLot[]) => LiveLot[];
}
const feed = <T>(f: Feed<T>): Feed<unknown> => f as Feed<unknown>;
const all = (lots: LiveLot[]) => lots;

const FEEDS: Record<string, Feed<unknown>> = {
  Taipei: feed({
    name: "臺北市停車管理工程處",
    // Through the relay: shared between visitors and compressed (the source sends 670 KB uncompressed).
    fetch: async () => parseTaipeiCounts(await getText("https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml", { route: "relay", timeout: 20000 })),
    join: joinTaipei,
  }),
  Taoyuan: feed({
    name: "桃園市政府交通局",
    fetch: async () =>
      parseTaoyuan(
        await getText("https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download", { route: "relay", timeout: 20000 }),
      ),
    join: all,
  }),
  Taichung: feed({
    name: "臺中市政府交通局",
    fetch: async () => parseTaichung(await getJson("https://motoretag.taichung.gov.tw/DataAPI/api/ParkingSpotListAPIV2", { timeout: 20000 })),
    join: all,
  }),
  Tainan: feed({
    name: "臺南市政府交通局",
    fetch: async () => parseTainan(await getJson("https://parkweb.tainan.gov.tw/api/parking.php", { route: "relay", timeout: 20000 })),
    join: all,
  }),
};

/** Whether a city publishes live counts anyone can read. */
export function hasOpenFeed(city: string): boolean {
  return city in FEEDS;
}

export function openFeedName(city: string): string {
  return FEEDS[city]?.name ?? "";
}

export const OPEN_FEED_CITIES = Object.keys(FEEDS);

const fetched = new Map<string, { at: number; raw: Promise<unknown> }>();

/**
 * Live lots for a city. The download is kept for a minute (the cities update
 * about that often), so panning only re-joins it with the lots now in view.
 */
export async function openLots(city: string, catalog: CatalogLot[], force = false): Promise<LiveLot[]> {
  const f = FEEDS[city];
  if (!f) return [];
  let hit = fetched.get(city);
  if (!hit || Date.now() - hit.at > (force ? 30000 : 60000)) {
    hit = { at: Date.now(), raw: f.fetch() };
    fetched.set(city, hit);
    const mine = hit;
    hit.raw.catch(() => fetched.get(city) === mine && fetched.delete(city));
  }
  return f.join(await hit.raw, catalog);
}
