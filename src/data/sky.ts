// Keyless global feeds: radar, cloud imagery, earthquakes, aircraft, satellites.

import { degreesLat, degreesLong, ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from "../lib/sgp4";
import { FeedError, getJson, getText, type Route } from "../lib/net";
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

/** A recent time whose tiles exist, from GIBS DescribeDomains (a small XML), or null. */
export async function cloudTime(layer: string, signal?: AbortSignal): Promise<string | null> {
  const q = new URLSearchParams({ SERVICE: "WMTS", REQUEST: "DescribeDomains", VERSION: "1.0.0", LAYER: layer, TILEMATRIXSET: CLOUD_MATRIX });
  try {
    return settledTime(latestDomainTime(await getText(`${GIBS}/wmts.cgi?${q}`, { signal, timeout: 12000 })));
  } catch {
    return null;
  }
}

/**
 * GIBS lists a geostationary time before all of its tiles are published
 * (the probe saw 404s at the newest step), so step back 30 minutes.
 */
export function settledTime(latest: string | null): string | null {
  if (!latest || !latest.includes("T")) return latest;
  const t = Date.parse(latest) - 30 * 60000;
  if (!Number.isFinite(t)) return null;
  const step = 10 * 60000;
  return new Date(Math.floor(t / step) * step).toISOString().replace(/\.\d{3}Z$/, "Z");
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

// ---- Aircraft (community ADS-B networks) ------------------------------------

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
  /** When the position was received (ms), if the feed said. */
  at: number | null;
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

/** readsb "v2" JSON, used by adsb.lol, airplanes.live and adsb.fi. */
export function parseAdsb(d: { ac?: AdsbRow[]; aircraft?: AdsbRow[]; now?: number }): Aircraft[] {
  const out: Aircraft[] = [];
  // `now` is the feed's clock: milliseconds, or seconds in older readsb builds.
  const now = finite(d.now) ? (d.now < 1e12 ? d.now * 1000 : d.now) : null;
  for (const a of d.ac ?? d.aircraft ?? []) {
    const pos = point(a.lat, a.lon);
    if (!pos || !a.hex) continue;
    out.push({
      id: a.hex.replace(/^~/, ""),
      callsign: (a.flight ?? "").trim(),
      reg: a.r ?? "",
      type: a.t ?? "",
      ...pos,
      altFt: finite(a.alt_baro) ? a.alt_baro : null,
      onGround: a.alt_baro === "ground",
      speedKt: num(a.gs),
      track: num(a.track) ?? num(a.true_heading),
      seen: num(a.seen_pos),
      at: now === null ? null : now - (num(a.seen_pos) ?? 0) * 1000,
    });
  }
  return out;
}

/** OpenSky state vectors: positional arrays, metres and m/s. */
export function parseOpenSky(d: { time?: number; states?: unknown[][] | null }): Aircraft[] {
  const out: Aircraft[] = [];
  for (const s of d.states ?? []) {
    const pos = point(s[6], s[5]);
    const id = typeof s[0] === "string" ? s[0] : "";
    if (!pos || !id) continue;
    const alt = num(s[7]);
    const speed = num(s[9]);
    const at = num(s[3]);
    out.push({
      id,
      callsign: typeof s[1] === "string" ? s[1].trim() : "",
      reg: "",
      type: "",
      ...pos,
      altFt: alt === null ? null : alt * 3.28084,
      onGround: s[8] === true,
      speedKt: speed === null ? null : speed * 1.943844,
      track: num(s[10]),
      seen: at !== null && finite(d.time) ? Math.max(0, d.time - at) : null,
      at: at === null ? null : at * 1000,
    });
  }
  return out;
}

interface FlightSource {
  name: string;
  url(lat: number, lng: number, nm: number): string;
  route: Route;
  parse(d: unknown): Aircraft[];
}

// None of these let browsers read them directly (scripts/live-probe.mjs), so
// all go through the relay. adsb.lol only rate-limits Cloudflare's shared
// IPs now and then; the others refuse them outright, so it goes first.
export const FLIGHT_SOURCES: FlightSource[] = [
  {
    name: "adsb.lol",
    url: (lat, lng, nm) => `https://api.adsb.lol/v2/point/${lat}/${lng}/${nm}`,
    route: "relay",
    parse: (d) => parseAdsb(d as Parameters<typeof parseAdsb>[0]),
  },
  {
    name: "airplanes.live",
    url: (lat, lng, nm) => `https://api.airplanes.live/v2/point/${lat}/${lng}/${nm}`,
    route: "direct-then-relay",
    parse: (d) => parseAdsb(d as Parameters<typeof parseAdsb>[0]),
  },
  {
    name: "adsb.fi",
    url: (lat, lng, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lng}/dist/${nm}`,
    route: "direct-then-relay",
    parse: (d) => parseAdsb(d as Parameters<typeof parseAdsb>[0]),
  },
  {
    name: "adsb.one",
    url: (lat, lng, nm) => `https://api.adsb.one/v2/point/${lat}/${lng}/${nm}`,
    route: "direct-then-relay",
    parse: (d) => parseAdsb(d as Parameters<typeof parseAdsb>[0]),
  },
  {
    name: "OpenSky Network",
    url: (lat, lng, nm) => {
      const dLat = (nm * 1.852) / 111.32;
      const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const q = new URLSearchParams({ lamin: (lat - dLat).toFixed(2), lamax: (lat + dLat).toFixed(2), lomin: (lng - dLng).toFixed(2), lomax: (lng + dLng).toFixed(2) });
      return `https://opensky-network.org/api/states/all?${q}`;
    },
    route: "direct-then-relay",
    parse: (d) => parseOpenSky(d as Parameters<typeof parseOpenSky>[0]),
  },
];

/** Longest a position is carried forward along its track before it is shown as stale. */
export const DEAD_RECKON_S = 120;

/**
 * Where an aircraft is now, carried along its track from when its position
 * was received (`fallbackAt` when the feed gave no time).
 */
export function extrapolate(a: Aircraft, now: number, fallbackAt: number): { lat: number; lng: number; stale: boolean } {
  const dt = (now - (a.at ?? fallbackAt)) / 1000;
  if (a.onGround || a.speedKt === null || a.track === null || dt <= 0) return { lat: a.lat, lng: a.lng, stale: dt > DEAD_RECKON_S };
  const t = Math.min(dt, DEAD_RECKON_S);
  const d = (a.speedKt * 0.514444 * t) / 111320;
  const rad = (a.track * Math.PI) / 180;
  return { lat: a.lat + d * Math.cos(rad), lng: a.lng + (d * Math.sin(rad)) / Math.cos((a.lat * Math.PI) / 180), stale: dt > DEAD_RECKON_S };
}

/** Snap the query so nearby visitors share relay cache entries. */
export function flightQuery(p: Point, radiusNm: number): { lat: number; lng: number; nm: number } {
  const nm = [25, 50, 100, 150, 250].find((b) => b >= radiusNm) ?? 250;
  const grid = nm <= 50 ? 0.1 : 0.25;
  const snap = (v: number) => Math.round(v / grid) * grid;
  return { lat: Number(snap(p.lat).toFixed(2)), lng: Number(snap(p.lng).toFixed(2)), nm };
}

let preferred = 0;

/** Aircraft around a point from the first network that answers. */
export async function aircraftNear(p: Point, radiusNm: number, signal?: AbortSignal): Promise<{ aircraft: Aircraft[]; source: string }> {
  const q = flightQuery(p, radiusNm);
  let lastError: unknown = null;
  for (let k = 0; k < FLIGHT_SOURCES.length; k++) {
    const i = (preferred + k) % FLIGHT_SOURCES.length;
    const src = FLIGHT_SOURCES[i];
    try {
      const aircraft = src.parse(await getJson(src.url(q.lat, q.lng, q.nm), { signal, route: src.route, timeout: 10000 }));
      preferred = i;
      return { aircraft, source: src.name };
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new FeedError("航班來源都暫時無法使用");
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

/** Position plus ground heading and orbital speed, for tracking. */
export function satMotion(s: Satellite, when: Date): (SatPosition & { heading: number; speedKmS: number }) | null {
  const p = satPosition(s, when);
  const q = satPosition(s, new Date(when.getTime() + 1000));
  const pv = propagate(s.satrec, when);
  if (!p || !q || !pv || typeof pv.velocity !== "object") return null;
  const y = Math.sin(((q.lng - p.lng) * Math.PI) / 180) * Math.cos((q.lat * Math.PI) / 180);
  const x =
    Math.cos((p.lat * Math.PI) / 180) * Math.sin((q.lat * Math.PI) / 180) -
    Math.sin((p.lat * Math.PI) / 180) * Math.cos((q.lat * Math.PI) / 180) * Math.cos(((q.lng - p.lng) * Math.PI) / 180);
  const v = pv.velocity;
  return { ...p, heading: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, speedKmS: Math.hypot(v.x, v.y, v.z) };
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
