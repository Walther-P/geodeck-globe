// Radio stations worldwide from Radio Browser (community database, keyless,
// allows browser reads). Only streams an https page can play are kept.

import { FeedError, getJson } from "../lib/net";
import { num, point, safeUrl, type Point } from "../lib/util";

const SERVERS = ["https://de1.api.radio-browser.info", "https://fi1.api.radio-browser.info", "https://de2.api.radio-browser.info"];

export interface Station {
  id: string;
  name: string;
  url: string;
  homepage: string | null;
  favicon: string | null;
  country: string;
  countryCode: string;
  state: string;
  language: string;
  tags: string[];
  codec: string;
  bitrate: number | null;
  lat: number;
  lng: number;
  clicks: number;
}

interface RbStation {
  stationuuid?: string;
  name?: string;
  url_resolved?: string;
  url?: string;
  homepage?: string;
  favicon?: string;
  country?: string;
  countrycode?: string;
  state?: string;
  language?: string;
  tags?: string;
  codec?: string;
  bitrate?: number;
  geo_lat?: number | null;
  geo_long?: number | null;
  clickcount?: number;
  hls?: number;
  lastcheckok?: number;
}

/** Playable here: https (no mixed content), last check passed, HLS only where the browser plays it natively. */
export function parseStations(rows: RbStation[], hlsOk: boolean): Station[] {
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const url = safeUrl(r.url_resolved || r.url, { httpsOnly: true });
    const pos = point(r.geo_lat, r.geo_long);
    if (!r.stationuuid || !r.name?.trim() || !url || !pos || r.lastcheckok === 0 || (r.hls === 1 && !hlsOk) || seen.has(r.stationuuid)) continue;
    seen.add(r.stationuuid);
    out.push({
      id: r.stationuuid,
      name: r.name.trim(),
      url,
      homepage: safeUrl(r.homepage),
      favicon: safeUrl(r.favicon, { httpsOnly: true }),
      country: r.country ?? "",
      countryCode: (r.countrycode ?? "").toUpperCase(),
      state: r.state ?? "",
      language: r.language ?? "",
      tags: (r.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
      codec: r.codec ?? "",
      bitrate: num(r.bitrate),
      ...pos,
      clicks: num(r.clickcount) ?? 0,
    });
  }
  return out;
}

let server = 0;

async function rb<T>(path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams(params);
  let last: unknown = null;
  for (let k = 0; k < SERVERS.length; k++) {
    const i = (server + k) % SERVERS.length;
    try {
      const d = await getJson<T>(`${SERVERS[i]}${path}?${q}`, { timeout: 12000 });
      server = i;
      return d;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new FeedError("電台資料庫暫時無法連線");
}

const BASE = { has_geo_info: "true", is_https: "true", hidebroken: "true", order: "clickcount", reverse: "true" };
const hls = () => typeof document !== "undefined" && document.createElement("audio").canPlayType("application/vnd.apple.mpegurl") !== "";

/** The most-played stations worldwide that have a location. */
export async function topStations(limit = 400): Promise<Station[]> {
  return parseStations(await rb<RbStation[]>("/json/stations/search", { ...BASE, limit: String(limit) }), hls());
}

/** Stations within `km` of a point, most-played first. */
export async function stationsNear(p: Point, km: number, limit = 300): Promise<Station[]> {
  const rows = await rb<RbStation[]>("/json/stations/search", {
    ...BASE,
    limit: String(limit),
    geo_lat: p.lat.toFixed(3),
    geo_long: p.lng.toFixed(3),
    geo_distance: String(Math.round(Math.min(km, 3000) * 1000)),
  });
  return parseStations(rows, hls());
}

/** Radio Browser asks players to report a play; it also keeps popularity honest. */
export function countPlay(id: string): void {
  void rb(`/json/url/${encodeURIComponent(id)}`, {}).catch(() => {});
}
