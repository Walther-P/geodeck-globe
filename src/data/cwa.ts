// 中央氣象署開放資料 with the visitor's own 授權碼. CWA has changed key casing
// between dataset versions (Earthquake/earthquake, EarthquakeInfo/...), so the
// readers accept both.

import { FeedError, getJson } from "../lib/net";
import { parseTime } from "../lib/time";
import { num, point, safeUrl } from "../lib/util";
import { hasCwa, keys } from "./keys";

const CWA_BASE = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

export async function cwaGet<T>(dataId: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  if (!hasCwa()) throw new FeedError("需要你自己的氣象署授權碼（設定 → 資料金鑰）");
  const url = `${CWA_BASE}/${dataId}?${new URLSearchParams({ Authorization: keys().cwa, format: "JSON", ...params })}`;
  const data = await getJson<{ success?: string | boolean; records?: unknown; result?: { message?: string } }>(url, {
    route: "direct-then-relay",
    timeout: 20000,
    signal,
  }).catch((e: FeedError) => {
    throw new FeedError(e.status === 401 || e.status === 403 ? "氣象署授權碼無效，請檢查" : `氣象署：${e.message}`, e.status);
  });
  if (data.success === "false" || data.success === false) throw new FeedError(`氣象署：${data.result?.message ?? "查詢失敗"}`);
  return (data.records ?? {}) as T;
}

/** Read the first present key among case variants. */
function pick<T = unknown>(o: unknown, ...names: string[]): T | undefined {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const n of names) if (rec[n] !== undefined) return rec[n] as T;
  return undefined;
}

const list = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v === undefined || v === null ? [] : [v as T]);

// ---- Weather warnings (W-C0033-001) ---------------------------------------

export interface Warning {
  area: string;
  phenomena: string;
  significance: string;
  start: number | null;
  end: number | null;
}

export function parseWarnings(records: unknown): Warning[] {
  const out: Warning[] = [];
  for (const loc of list(pick(records, "location", "Location"))) {
    const area = String(pick(loc, "locationName", "LocationName") ?? "");
    const hazards = list(pick(pick(loc, "hazardConditions", "HazardConditions"), "hazards", "Hazards"));
    for (const h of hazards) {
      const info = pick(h, "info", "Info");
      const valid = pick(h, "validTime", "ValidTime");
      const phenomena = String(pick(info, "phenomena", "Phenomena") ?? "");
      if (!phenomena) continue;
      out.push({
        area,
        phenomena,
        significance: String(pick(info, "significance", "Significance") ?? ""),
        start: parseTime(pick(valid, "startTime", "StartTime")),
        end: parseTime(pick(valid, "endTime", "EndTime")),
      });
    }
  }
  return out;
}

export async function warnings(signal?: AbortSignal): Promise<Warning[]> {
  return parseWarnings(await cwaGet("W-C0033-001", {}, signal));
}

// ---- Earthquake reports (E-A0015-001 significant, E-A0016-001 local) ------

export interface CwaQuake {
  id: string;
  lat: number;
  lng: number;
  magnitude: number | null;
  depthKm: number | null;
  time: number | null;
  location: string;
  maxIntensity: string;
  report: string;
  image: string | null;
  web: string | null;
}

export function parseQuakes(records: unknown): CwaQuake[] {
  const out: CwaQuake[] = [];
  for (const q of list(pick(records, "Earthquake", "earthquake"))) {
    const info = pick(q, "EarthquakeInfo", "earthquakeInfo");
    const epi = pick(info, "Epicenter", "epicenter");
    const pos = point(pick(epi, "EpicenterLatitude", "epicenterLatitude"), pick(epi, "EpicenterLongitude", "epicenterLongitude"));
    if (!pos) continue;
    const areas = list(pick(pick(q, "Intensity", "intensity"), "ShakingArea", "shakingArea"));
    let max = "";
    for (const a of areas) {
      const v = String(pick(a, "AreaIntensity", "areaIntensity") ?? "");
      if (v && intensityRank(v) > intensityRank(max)) max = v;
    }
    out.push({
      id: String(pick(q, "EarthquakeNo", "earthquakeNo") ?? `${pos.lat},${pos.lng}`),
      ...pos,
      magnitude: num(pick(pick(info, "EarthquakeMagnitude", "magnitude"), "MagnitudeValue", "magnitudeValue")),
      depthKm: num(pick(info, "FocalDepth", "depth")),
      time: parseTime(pick(info, "OriginTime", "originTime")),
      location: String(pick(epi, "Location", "location") ?? ""),
      maxIntensity: max,
      report: String(pick(q, "ReportContent", "reportContent") ?? ""),
      image: safeUrl(pick(q, "ReportImageURI", "reportImageURI"), { httpsOnly: true }),
      web: safeUrl(pick(q, "Web", "web")),
    });
  }
  return out;
}

/** "5弱" > "4級" > "3級"; unknown text ranks lowest. */
export function intensityRank(v: string): number {
  const m = v.match(/(\d)\s*(強|弱)?/);
  if (!m) return -1;
  return Number(m[1]) * 2 + (m[2] === "強" ? 1 : 0);
}

export async function quakes(signal?: AbortSignal): Promise<CwaQuake[]> {
  const params = { limit: "15" };
  const [big, local] = await Promise.allSettled([cwaGet("E-A0015-001", params, signal), cwaGet("E-A0016-001", params, signal)]);
  if (big.status === "rejected" && local.status === "rejected") throw big.reason;
  const all = [...(big.status === "fulfilled" ? parseQuakes(big.value) : []), ...(local.status === "fulfilled" ? parseQuakes(local.value) : [])];
  const seen = new Set<string>();
  return all.filter((q) => !seen.has(q.id) && seen.add(q.id)).sort((a, z) => (z.time ?? 0) - (a.time ?? 0));
}

// ---- Tropical cyclones (W-C0034-005) --------------------------------------

export interface CycloneFix {
  lat: number;
  lng: number;
  time: number | null;
  windMs: number | null;
  radius15Km: number | null;
  forecast: boolean;
}

export interface Cyclone {
  id: string;
  name: string;
  fixes: CycloneFix[];
}

function parseCoordinate(f: unknown) {
  // Older docs: coordinate "lng,lat"; the live feed (2026-10): CoordinateLongitude / CoordinateLatitude.
  const joined = pick(f, "coordinate", "Coordinate");
  if (typeof joined === "string") {
    const [lng, lat] = joined.split(",").map((x) => Number(x.trim()));
    return point(lat, lng);
  }
  return point(pick(f, "CoordinateLatitude", "coordinateLatitude", "Latitude"), pick(f, "CoordinateLongitude", "coordinateLongitude", "Longitude"));
}

export function parseCyclones(records: unknown): Cyclone[] {
  const root = pick(records, "tropicalCyclones", "TropicalCyclones");
  const out: Cyclone[] = [];
  for (const c of list(pick(root, "tropicalCyclone", "TropicalCyclone"))) {
    const fixes: CycloneFix[] = [];
    const read = (block: unknown, forecast: boolean) => {
      for (const f of list(pick(block, "fix", "Fix"))) {
        const pos = parseCoordinate(f);
        if (!pos) continue;
        let time = parseTime(pick(f, "fixTime", "FixTime", "DateTime", "dateTime"));
        if (forecast && time === null) {
          const init = parseTime(pick(f, "initTime", "InitTime"));
          const tau = num(pick(f, "tau", "Tau", "ForecastHour"));
          time = init !== null && tau !== null ? init + tau * 3600000 : null;
        }
        const circle = pick(f, "circleOf15Ms", "CircleOf15Ms");
        fixes.push({
          ...pos,
          time,
          windMs: num(pick(f, "maxWindSpeed", "MaxWindSpeed")),
          radius15Km: num(typeof circle === "object" ? pick(circle, "radius", "Radius") : circle),
          forecast,
        });
      }
    };
    read(pick(c, "analysisData", "AnalysisData"), false);
    read(pick(c, "forecastData", "ForecastData"), true);
    if (!fixes.length) continue;
    const name = String(pick(c, "cwaTyphoonName", "CwaTyphoonName") || pick(c, "typhoonName", "TyphoonName") || "熱帶性低氣壓");
    out.push({ id: String(pick(c, "cwaTyNo", "CwaTyNo", "cwaTdNo", "CwaTdNo", "typhoonName", "TyphoonName") ?? name), name, fixes });
  }
  return out;
}

export async function cyclones(signal?: AbortSignal): Promise<Cyclone[]> {
  return parseCyclones(await cwaGet("W-C0034-005", {}, signal));
}

export async function testCwa(): Promise<string> {
  const records = await cwaGet("W-C0033-001");
  return pick(records, "location", "Location") ? "氣象署授權碼可用" : "已連線，但回傳格式和預期不同";
}
