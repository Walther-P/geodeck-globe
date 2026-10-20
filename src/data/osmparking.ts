// Parking anywhere in the world from OpenStreetMap. Where the lots are comes
// from the basemap's own vector tiles (OpenFreeMap), so it costs nothing
// extra; tapping one reads its capacity, fee and hours from the OpenStreetMap
// API. There are no live counts; at home the Taiwan catalog and TDX have them.

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

const details = new Map<string, Promise<ParkingDetails | null>>();

/** One object's tags from the OpenStreetMap API; null when it is gone or not parking. */
export function parkingDetails(ref: OsmRef): Promise<ParkingDetails | null> {
  const key = `${ref.type}/${ref.id}`;
  if (!details.has(key))
    details.set(
      key,
      getJson<{ elements?: Array<{ tags?: Record<string, string> }> }>(`https://api.openstreetmap.org/api/0.6/${key}.json`, { timeout: 10000 }).then(
        (d) => {
          const tags = d.elements?.[0]?.tags;
          return tags?.amenity === "parking" ? describeParking(tags) : null;
        },
        (e) => {
          details.delete(key);
          throw e;
        },
      ),
    );
  return details.get(key)!;
}
