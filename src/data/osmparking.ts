// Parking anywhere in the world from OpenStreetMap. Where the lots are comes
// from the basemap's own vector tiles (OpenFreeMap), so it costs nothing
// extra; tapping one reads its capacity, fee and hours from the OpenStreetMap
// API. There are no live counts; at home the Taiwan catalog and TDX have them.
// EV charging points come the same way (tiles for where, the API for sockets).

import { getJson } from "../lib/net";
import { num } from "../lib/util";

export interface OsmRef {
  type: "node" | "way" | "relation";
  id: number;
}

/** OpenMapTiles feature ids are the OSM id times ten plus 1 (node), 2 (way) or 3–4 (relation). */
export function osmRef(featureId: unknown): OsmRef | null {
  const n = typeof featureId === "number" ? featureId : typeof featureId === "string" ? Number(featureId) : NaN;
  if (!Number.isSafeInteger(n) || n < 11) return null;
  const kind = n % 10;
  const type = kind === 1 ? "node" : kind === 2 ? "way" : kind === 3 || kind === 4 ? "relation" : null;
  return type ? { type, id: Math.floor(n / 10) } : null;
}

export function osmUrl(ref: OsmRef): string {
  return `https://www.openstreetmap.org/${ref.type}/${ref.id}`;
}

/** A display name from tile or OSM tags, preferring Traditional Chinese. */
export function osmName(tags: Record<string, unknown>): string {
  for (const k of ["name:zh-Hant", "name:zh-TW", "name", "name:zh", "name:en", "name_en"]) {
    const v = tags[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export interface ParkingDetails {
  name: string;
  kind: "lot" | "curb";
  /** Not open to the public (access=private/no, private garages). */
  closed: boolean;
  total: number | null;
  rate: string | null;
  hours: string | null;
  address: string;
  notes: string[];
}

const CURB = new Set(["street_side", "lane", "on_kerb", "half_on_kerb", "shoulder"]);
const TYPE_NAMES: Record<string, string> = {
  underground: "地下停車場",
  "multi-storey": "立體停車場",
  rooftop: "屋頂停車場",
  surface: "平面停車場",
};
const ACCESS_NOTES: Record<string, string> = {
  customers: "限消費顧客使用",
  permit: "需要停車許可",
  destination: "限前往附近的人使用",
  delivery: "限裝卸貨",
};

function fee(tags: Record<string, string>): string | null {
  const f = tags.fee?.trim();
  const charge = tags.charge?.trim();
  if (!f && !charge) return null;
  if (f === "no") return "免費";
  const when = f && f !== "yes" ? f.replace(/^yes\s*/i, "").replace(/^@\s*/, "").replace(/^\((.*)\)$/, "$1") : "";
  return [when ? `收費（${when}）` : "收費", charge].filter(Boolean).join(" · ");
}

export function describeParking(tags: Record<string, string>): ParkingDetails {
  const kind = CURB.has(tags.parking) ? "curb" : "lot";
  const notes = [
    ACCESS_NOTES[tags.access],
    TYPE_NAMES[tags.parking],
    tags.park_ride && tags.park_ride !== "no" ? "轉乘停車場" : null,
    tags.maxstay ? `最長停放 ${tags.maxstay}` : null,
    num(tags["capacity:disabled"]) ? `無障礙車位 ${tags["capacity:disabled"]} 格` : null,
    num(tags["capacity:charging"]) ? `充電車位 ${tags["capacity:charging"]} 格` : null,
  ].filter((x): x is string => !!x);
  const h = tags.opening_hours?.trim();
  return {
    name: osmName(tags) || (kind === "curb" ? "路邊停車" : TYPE_NAMES[tags.parking] ?? "停車場"),
    kind,
    closed: ["private", "no"].includes(tags.access) || ["garage_boxes", "carports"].includes(tags.parking),
    total: num(tags.capacity),
    rate: fee(tags),
    hours: h ? (h === "24/7" ? "24 小時" : h) : null,
    address: tags["addr:full"] || [tags["addr:city"], tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
    notes,
  };
}

const tags = new Map<string, Promise<Record<string, string> | null>>();

/** One object's tags from the OpenStreetMap API; null when it is gone. */
function osmTags(ref: OsmRef): Promise<Record<string, string> | null> {
  const key = `${ref.type}/${ref.id}`;
  if (!tags.has(key))
    tags.set(
      key,
      getJson<{ elements?: Array<{ tags?: Record<string, string> }> }>(`https://api.openstreetmap.org/api/0.6/${key}.json`, { timeout: 10000 }).then(
        (d) => d.elements?.[0]?.tags ?? null,
        (e) => {
          tags.delete(key);
          throw e;
        },
      ),
    );
  return tags.get(key)!;
}

/** Null when the object is gone or no longer parking. */
export async function parkingDetails(ref: OsmRef): Promise<ParkingDetails | null> {
  const t = await osmTags(ref);
  return t?.amenity === "parking" ? describeParking(t) : null;
}

// ---- EV charging -----------------------------------------------------------

export interface ChargerDetails {
  name: string;
  operator: string;
  closed: boolean;
  /** Vehicles that can charge at once. */
  capacity: number | null;
  sockets: Array<{ label: string; count: number | null; output: string }>;
  rate: string | null;
  hours: string | null;
  address: string;
  notes: string[];
}

const SOCKETS: Record<string, string> = {
  type2_combo: "CCS2",
  type1_combo: "CCS1",
  chademo: "CHAdeMO",
  type2: "Type 2（交流）",
  type2_cable: "Type 2 附線（交流）",
  type1: "Type 1／J1772（交流）",
  tesla_supercharger: "Tesla 超充",
  tesla_supercharger_ccs: "Tesla 超充（CCS）",
  tesla_destination: "Tesla 目的地充電",
  nacs: "NACS（Tesla）",
  gb_dc: "GB/T 直流",
  gb_ac: "GB/T 交流",
  schuko: "家用插座（Schuko）",
  typee: "家用插座（Type E）",
  bs1363: "家用插座（英規）",
  cee_blue: "CEE 藍色插座",
  type3c: "Type 3C",
};

export function describeCharger(t: Record<string, string>): ChargerDetails {
  const sockets = Object.keys(t)
    .map((k) => k.match(/^socket:([a-z0-9_]+)$/)?.[1])
    .filter((k): k is string => !!k && t[`socket:${k}`] !== "no")
    .map((k) => ({ label: SOCKETS[k] ?? k, count: num(t[`socket:${k}`]), output: t[`socket:${k}:output`]?.trim() ?? "" }));
  const two = ["motorcycle", "scooter", "bicycle"].filter((v) => t[v] === "yes");
  const notes = [
    two.length && t.motorcar !== "yes" ? `供${two.map((v) => (v === "bicycle" ? "自行車" : "機車")).filter((x, i, a) => a.indexOf(x) === i).join("、")}使用` : null,
    t.authentication && t.authentication !== "none" ? `認證：${t.authentication}` : null,
    Object.keys(t).some((k) => k.startsWith("authentication:") && t[k] === "yes")
      ? `認證方式：${Object.keys(t)
          .filter((k) => k.startsWith("authentication:") && t[k] === "yes")
          .map((k) => k.slice(15))
          .join("、")}`
      : null,
    t["parking:fee"] === "yes" ? "另需停車費" : null,
    ACCESS_NOTES[t.access],
  ].filter((x): x is string => !!x);
  const h = t.opening_hours?.trim();
  return {
    name: osmName(t) || t.brand || t.operator || "充電站",
    operator: [t.operator, t.network, t.brand].find((x) => x?.trim())?.trim() ?? "",
    closed: ["private", "no"].includes(t.access),
    capacity: num(t.capacity),
    sockets,
    rate: fee(t),
    hours: h ? (h === "24/7" ? "24 小時" : h) : null,
    address: t["addr:full"] || [t["addr:city"], t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "),
    notes,
  };
}

/** Null when the object is gone or no longer a charging station. */
export async function chargerDetails(ref: OsmRef): Promise<ChargerDetails | null> {
  const t = await osmTags(ref);
  return t?.amenity === "charging_station" ? describeCharger(t) : null;
}
