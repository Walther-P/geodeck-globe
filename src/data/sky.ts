// Keyless global feeds: radar, cloud imagery, earthquakes, aircraft, satellites.

import { degreesLat, degreesLong, ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from "../lib/sgp4";
import { FeedError, getJson, getText } from "../lib/net";
import { finite, num, point, safeUrl, type Point } from "../lib/util";

// ---- Radar (RainViewer) ---------------------------------------------------

export interface RadarFrame {
  time: number;
  tiles: string;
}

export async function radarFrames(signal?: AbortSignal): Promise<RadarFrame[]> {
  const d = await getJson<{ host?: string; radar?: { past?: Array<{ time: number; path: string }> } }>(
    "https://api.rainviewer.com/public/weather-maps.json",
    { signal },
  );
  const host = d.host ?? "";
  if (!/^https:\/\/([a-z0-9-]+\.)*rainviewer\.com$/.test(host)) throw new FeedError("雷達來源格式異常");
  return (d.radar?.past ?? [])
    .filter((f) => finite(f.time) && /^\/[\w/.-]+$/.test(f.path))
    .map((f) => ({ time: f.time * 1000, tiles: `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
}

// ---- Clouds (NASA GIBS geostationary infrared) ----------------------------

/** Himawari covers East Asia/Pacific; GOES the Americas; elsewhere a daily layer. */
export function cloudLayer(lng: number): string {
  if (lng >= 60 || lng <= -160) return "Himawari_AHI_Band13_Clean_Infrared";
  if (lng < -95) return "GOES-West_ABI_Band13_Clean_Infrared";
  if (lng < -20) return "GOES-East_ABI_Band13_Clean_Infrared";
  return "MODIS_Terra_Cloud_Top_Temp_Day";
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
export const CLOUD_MATRIX = "GoogleMapsCompatible_Level6";

/** Latest available time from GIBS DescribeDomains (a small XML), or null. */
export async function cloudTime(layer: string, signal?: AbortSignal): Promise<string | null> {
  const q = new URLSearchParams({ SERVICE: "WMTS", REQUEST: "DescribeDomains", VERSION: "1.0.0", LAYER: layer, TILEMATRIXSET: CLOUD_MATRIX });
  try {
    return latestDomainTime(await getText(`${GIBS}/wmts.cgi?${q}`, { signal, timeout: 12000 }));
  } catch {
    return null;
  }
}

export function latestDomainTime(xml: string): string | null {
  const domain = xml.match(/<Domain>([^<]+)<\/Domain>/g)?.pop()?.replace(/<\/?Domain>/g, "") ?? "";
  const last = domain.split(",").pop()?.trim() ?? "";
  const end = last.split("/")[1] ?? last.split("/")[0];
  return /^\d{4}-\d{2}-\d{2}(T[\d:]+Z)?$/.test(end ?? "") ? end! : null;
}

export function cloudTiles(layer: string, time: string | null): string {
  // Without a time GIBS serves its default (latest) image.
  const t = time ?? "default";
  return `${GIBS}/${layer}/default/${t}/${CLOUD_MATRIX}/{z}/{y}/{x}.png`;
}

// ---- Earthquakes (USGS, worldwide M2.5+) ------------------------------------

export interface Quake {
  id: string;
  lat: number;
  lng: number;
  magnitude: number | null;
  depthKm: number | null;
  time: number | null;
  place: string;
  url: string | null;
  source: "USGS" | "氣象署";
}

export function parseUsgs(d: { features?: Array<{ id?: string; geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }> }): Quake[] {
  const out: Quake[] = [];
  for (const f of d.features ?? []) {
    const [lng, lat, depth] = f.geometry?.coordinates ?? [];
    const pos = point(lat, lng);
    if (!pos || !f.id) continue;
    const p = f.properties ?? {};
    out.push({
      id: `usgs-${f.id}`,
      ...pos,
      magnitude: num(p.mag),
      depthKm: num(depth),
      time: num(p.time),
      place: String(p.place ?? ""),
      url: safeUrl(p.url, { httpsOnly: true }),
      source: "USGS",
    });
  }
  return out;
}

export async function usgsQuakes(signal?: AbortSignal): Promise<Quake[]> {
  const d = await getJson<Parameters<typeof parseUsgs>[0]>("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", {
    signal,
    route: "direct-then-relay",
  });
  return parseUsgs(d);
}

// ---- Aircraft (adsb.lol, community ADS-B) ---------------------------------

export interface Aircraft {
  id: string;
  callsign: string;
  reg: string;
  type: string;
  lat: number;
  lng: number;
  altFt: number | null;
  onGround: boolean;
  speedKt: number | null;
  track: number | null;
  /** Seconds since the position was received. */
  seen: number | null;
}

interface AdsbRow {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  true_heading?: number;
  seen_pos?: number;
}

export function parseAdsb(d: { ac?: AdsbRow[] }): Aircraft[] {
  const out: Aircraft[] = [];
  for (const a of d.ac ?? []) {
    const pos = point(a.lat, a.lon);
    if (!pos || !a.hex) continue;
    out.push({
      id: a.hex,
      callsign: (a.flight ?? "").trim(),
      reg: a.r ?? "",
      type: a.t ?? "",
      ...pos,
      altFt: finite(a.alt_baro) ? a.alt_baro : null,
      onGround: a.alt_baro === "ground",
      speedKt: num(a.gs),
      track: num(a.track) ?? num(a.true_heading),
      seen: num(a.seen_pos),
    });
  }
  return out;
}

/** radius in nautical miles; adsb.lol caps it at 250. */
export async function aircraftNear(p: Point, radiusNm: number, signal?: AbortSignal): Promise<Aircraft[]> {
  const r = Math.max(5, Math.min(250, Math.round(radiusNm)));
  const url = `https://api.adsb.lol/v2/point/${p.lat.toFixed(3)}/${p.lng.toFixed(3)}/${r}`;
  return parseAdsb(await getJson(url, { signal, route: "direct-then-relay", timeout: 12000 }));
}

// ---- Satellites (CelesTrak GP + SGP4) -------------------------------------

export interface Satellite {
  id: string;
  name: string;
  satrec: SatRec;
}

export function parseTle(text: string): Satellite[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out: Satellite[] = [];
  for (let i = 0; i < lines.length; ) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (l1?.startsWith("1 ") && l2?.startsWith("2 ")) {
      try {
        const satrec = twoline2satrec(l1, l2);
        if (!satrec.error) out.push({ id: l1.slice(2, 7).trim(), name: name.trim(), satrec });
      } catch {
        /* skip malformed element set */
      }
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

export interface SatPosition {
  id: string;
  name: string;
  lat: number;
  lng: number;
  altKm: number;
}

export function satPosition(s: Satellite, when: Date): SatPosition | null {
  const pv = propagate(s.satrec, when);
  if (!pv || typeof pv.position !== "object") return null;
  const g = eciToGeodetic(pv.position, gstime(when));
  const lat = degreesLat(g.latitude);
  let lng = degreesLong(g.longitude);
  if (lng > 180) lng -= 360;
  if (!finite(lat) || !finite(lng) || !finite(g.height)) return null;
  return { id: s.id, name: s.name, lat, lng, altKm: g.height };
}

/** Ground track sampled every `stepMin` minutes, split at the antimeridian. */
export function groundTrack(s: Satellite, from: Date, minutes = 95, stepMin = 1): Array<Array<[number, number]>> {
  const parts: Array<Array<[number, number]>> = [[]];
  let prev: number | null = null;
  for (let m = 0; m <= minutes; m += stepMin) {
    const p = satPosition(s, new Date(from.getTime() + m * 60000));
    if (!p) continue;
    if (prev !== null && Math.abs(p.lng - prev) > 180) parts.push([]);
    parts[parts.length - 1].push([p.lng, p.lat]);
    prev = p.lng;
  }
  return parts.filter((x) => x.length > 1);
}

export interface Pass {
  rise: number;
  peak: number;
  set: number;
  maxElevation: number;
  riseAzimuth: number;
}

/** Next time the satellite climbs above `minElevation` degrees as seen from `observer`. */
export function nextPass(s: Satellite, observer: Point, from = new Date(), hours = 24, minElevation = 10): Pass | null {
  const site = { latitude: (observer.lat * Math.PI) / 180, longitude: (observer.lng * Math.PI) / 180, height: 0.05 };
  const look = (t: number) => {
    const when = new Date(t);
    const pv = propagate(s.satrec, when);
    if (!pv || typeof pv.position !== "object") return null;
    const ecf = eciToEcf(pv.position, gstime(when));
    const a = ecfToLookAngles(site, ecf);
    return { el: (a.elevation * 180) / Math.PI, az: (((a.azimuth * 180) / Math.PI) % 360 + 360) % 360 };
  };
  const step = 30000;
  const end = from.getTime() + hours * 3600000;
  let pass: Pass | null = null;
  for (let t = from.getTime(); t < end; t += step) {
    const l = look(t);
    if (!l) continue;
    if (!pass && l.el >= minElevation) pass = { rise: t, peak: t, set: t, maxElevation: l.el, riseAzimuth: l.az };
    else if (pass && l.el >= minElevation) {
      pass.set = t;
      if (l.el > pass.maxElevation) {
        pass.maxElevation = l.el;
        pass.peak = t;
      }
    } else if (pass) return pass;
  }
  return pass;
}

export function compass(az: number): string {
  return ["北", "東北", "東", "東南", "南", "西南", "西", "西北"][Math.round(az / 45) % 8];
}

export type SatGroup = "stations" | "visual" | "starlink";

export async function satellites(group: SatGroup, signal?: AbortSignal): Promise<Satellite[]> {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  let text: string;
  try {
    text = await getText(url, { signal, route: "relay", timeout: 20000 });
  } catch (e) {
    // The build bundles a recent snapshot for when CelesTrak is unreachable.
    const r = await fetch(`./data/tle-${group}.txt`).catch(() => null);
    if (!r?.ok) throw e;
    text = await r.text();
  }
  const sats = parseTle(text);
  if (!sats.length) throw new FeedError("衛星軌道資料無法讀取");
  return sats;
}
