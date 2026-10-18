// TDX (交通部運輸資料流通服務) with the visitor's own client id/secret.
// Field names follow the MOTC transport data standard; every reader below
// tolerates missing fields because city feeds differ in completeness.

import { FeedError, getJson } from "../lib/net";
import { read, remove, write } from "../lib/store";
import { parseTime } from "../lib/time";
import { num, point, safeUrl } from "../lib/util";
import { hasTdx, keys } from "./keys";

export const TDX_BASE = "https://tdx.transportdata.tw";
const TOKEN_URL = `${TDX_BASE}/auth/realms/TDXConnect/protocol/openid-connect/token`;
const TOKEN_STORAGE = "gdg.tdx.token.v1";

interface StoredToken {
  id: string;
  token: string;
  expires: number;
}

let pendingToken: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const { tdxId, tdxSecret } = keys();
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: tdxId, client_secret: tdxSecret }).toString();
  const data = await getJson<{ access_token?: string; expires_in?: number }>(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    route: "relay",
  }).catch((e: FeedError) => {
    throw new FeedError(e.status === 400 || e.status === 401 ? "TDX 金鑰無效，請檢查 Client ID 與 Client Secret" : `TDX 登入失敗：${e.message}`, e.status);
  });
  if (!data.access_token) throw new FeedError("TDX 沒有回傳登入憑證");
  const expires = Date.now() + Math.max(300, (data.expires_in ?? 3600) - 300) * 1000;
  write(TOKEN_STORAGE, { id: tdxId, token: data.access_token, expires } satisfies StoredToken);
  return data.access_token;
}

export async function tdxToken(): Promise<string> {
  if (!hasTdx()) throw new FeedError("需要你自己的 TDX 金鑰（設定 → 資料金鑰）");
  const stored = read<StoredToken | null>(TOKEN_STORAGE, null);
  if (stored && stored.id === keys().tdxId && stored.expires > Date.now()) return stored.token;
  pendingToken ??= fetchToken().finally(() => (pendingToken = null));
  return pendingToken;
}

export function forgetTdxToken(): void {
  remove(TOKEN_STORAGE);
}

// TDX's free tier allows only a few calls per second per key, and opening a
// lens can ask for half a dozen feeds at once: send them one at a time.
const SPACING_MS = 250;
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => {}).then(async () => {
    const wait = lastCall + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run;
  return run;
}

export async function tdxGet<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const url = `${TDX_BASE}${path}?${new URLSearchParams({ $format: "JSON", ...params })}`;
  const attempt = async () => {
    const token = await tdxToken();
    return paced(() =>
      getJson<T>(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        // TDX doesn't allow browser reads (no CORS), so always via our relay.
        route: "relay",
        timeout: 20000,
        signal,
      }),
    );
  };
  try {
    return await attempt();
  } catch (e) {
    // A token revoked or rotated early: retry once with a fresh one.
    if (e instanceof FeedError && e.status === 401) {
      forgetTdxToken();
      return attempt();
    }
    // Over the per-second limit: wait a moment and try once more.
    if (e instanceof FeedError && e.status === 429 && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1500));
      return attempt();
    }
    throw e;
  }
}

const zh = (v: unknown): string => {
  if (typeof v === "string") return v;
  const o = v as { Zh_tw?: string; Zh_TW?: string; En?: string } | null;
  return o?.Zh_tw ?? o?.Zh_TW ?? o?.En ?? "";
};

// ---- Parking -------------------------------------------------------------

export interface LiveLot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  total: number | null;
  available: number | null;
  updatedAt: number | null;
  full: boolean;
  address: string;
  fare: string;
  city: string;
  source: "tdx";
}

interface TdxCarPark {
  CarParkID?: string;
  CarParkName?: unknown;
  CarParkPosition?: { PositionLat?: number; PositionLon?: number };
  Address?: string;
  FareDescription?: string;
}

interface TdxAvailability {
  CarParkID?: string;
  TotalSpaces?: number;
  AvailableSpaces?: number;
  FullStatus?: number;
  ServiceStatus?: number;
  DataCollectTime?: string;
  Availabilities?: Array<{ SpaceType?: number; NumberOfSpaces?: number; AvailableSpaces?: number }>;
}

/** Negative counts are the standard's "no data" marker. */
const count = (v: unknown) => {
  const n = num(v);
  return n === null || n < 0 ? null : Math.round(n);
};

export function normalizeLiveLots(
  carParks: { CarParks?: TdxCarPark[] } | TdxCarPark[],
  availability: { ParkingAvailabilities?: TdxAvailability[]; UpdateTime?: string } | TdxAvailability[],
  city: string,
): LiveLot[] {
  const parks = Array.isArray(carParks) ? carParks : (carParks.CarParks ?? []);
  const rows = Array.isArray(availability) ? availability : (availability.ParkingAvailabilities ?? []);
  const feedTime = Array.isArray(availability) ? null : parseTime(availability.UpdateTime);
  const byId = new Map(rows.filter((r) => r.CarParkID).map((r) => [r.CarParkID!, r]));
  const out: LiveLot[] = [];
  for (const p of parks) {
    const pos = point(p.CarParkPosition?.PositionLat, p.CarParkPosition?.PositionLon);
    if (!pos || !p.CarParkID) continue;
    const a = byId.get(p.CarParkID);
    // Prefer the car (SpaceType 1) breakdown when a lot also counts scooters.
    const car = a?.Availabilities?.find((x) => x.SpaceType === 1);
    const available = count(car?.AvailableSpaces ?? a?.AvailableSpaces);
    out.push({
      id: `tdx-${city}-${p.CarParkID}`,
      name: zh(p.CarParkName) || "停車場",
      ...pos,
      total: count(car?.NumberOfSpaces ?? a?.TotalSpaces),
      available: a?.ServiceStatus === 0 ? null : available,
      // Only the per-lot collection time proves a count is current.
      updatedAt: parseTime(a?.DataCollectTime) ?? (a ? feedTime : null),
      full: a?.FullStatus === 1 || available === 0,
      address: p.Address ?? "",
      fare: p.FareDescription ?? "",
      city,
      source: "tdx",
    });
  }
  return out;
}

export async function liveLots(city: string, signal?: AbortSignal): Promise<LiveLot[]> {
  const [parks, avail] = await Promise.all([
    tdxGet<{ CarParks?: TdxCarPark[] }>(`/api/basic/v1/Parking/OffStreet/CarPark/City/${city}`, {}, signal),
    tdxGet<{ ParkingAvailabilities?: TdxAvailability[] }>(`/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/${city}`, {}, signal),
  ]);
  return normalizeLiveLots(parks, avail, city);
}

// ---- CCTV ----------------------------------------------------------------

export interface Camera {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** The operator's own feed (MJPEG stream or still image). */
  image: string | null;
  /** A third-party still snapshot, used only when there is no official feed. */
  mirror?: string | null;
  page: string | null;
  source: string;
}

/**
 * Pages are https, so an operator feed that is http-only goes through our
 * Worker (government hosts only); everything else loads directly.
 */
export function cameraSrc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && /(^|\.)gov\.tw$/.test(u.hostname)) return `./api/cam?u=${encodeURIComponent(u.toString())}`;
  } catch {
    /* not a URL */
  }
  return null;
}

interface TdxCctv {
  CCTVID?: string;
  VideoStreamURL?: string;
  VideoImageURL?: string;
  PositionLat?: number;
  PositionLon?: number;
  RoadName?: string;
  RoadDirection?: string;
  LocationMile?: string;
  SurveillanceDescription?: string;
}

const DIRECTION: Record<string, string> = { N: "北向", S: "南向", E: "東向", W: "西向", O: "外環", I: "內環" };

export function normalizeCctv(data: { CCTVs?: TdxCctv[] } | TdxCctv[], scope: string): Camera[] {
  const rows = Array.isArray(data) ? data : (data.CCTVs ?? []);
  const out: Camera[] = [];
  for (const c of rows) {
    const pos = point(c.PositionLat, c.PositionLon);
    if (!pos || !c.CCTVID) continue;
    const name =
      c.SurveillanceDescription ||
      [c.RoadName, c.LocationMile, c.RoadDirection ? DIRECTION[c.RoadDirection] ?? c.RoadDirection : ""].filter(Boolean).join(" ") ||
      "道路影像";
    out.push({
      id: `tdx-${scope}-${c.CCTVID}`,
      name,
      ...pos,
      image: safeUrl(c.VideoImageURL) ?? safeUrl(c.VideoStreamURL),
      mirror: null,
      page: null,
      source: "TDX",
    });
  }
  return out;
}

export async function cctv(scope: "Freeway" | "Highway" | string, signal?: AbortSignal): Promise<Camera[]> {
  const path = scope === "Freeway" || scope === "Highway" ? `/api/basic/v2/Road/Traffic/CCTV/${scope}` : `/api/basic/v2/Road/Traffic/CCTV/City/${scope}`;
  return normalizeCctv(await tdxGet(path, {}, signal), scope);
}

// ---- Buses ---------------------------------------------------------------

export interface Bus {
  id: string;
  route: string;
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  at: number | null;
}

interface TdxBus {
  PlateNumb?: string;
  RouteName?: unknown;
  BusPosition?: { PositionLat?: number; PositionLon?: number };
  Speed?: number;
  Azimuth?: number;
  GPSTime?: string;
  DutyStatus?: number;
  BusStatus?: number;
}

export function normalizeBuses(rows: TdxBus[]): Bus[] {
  const out = new Map<string, Bus>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const pos = point(r.BusPosition?.PositionLat, r.BusPosition?.PositionLon);
    // BusStatus 99 = not operating; DutyStatus 2 = finished its run.
    if (!pos || !r.PlateNumb || r.BusStatus === 99 || r.DutyStatus === 2) continue;
    const at = parseTime(r.GPSTime);
    const prev = out.get(r.PlateNumb);
    if (prev && (prev.at ?? 0) >= (at ?? 0)) continue;
    out.set(r.PlateNumb, { id: r.PlateNumb, route: zh(r.RouteName), ...pos, speed: num(r.Speed), heading: num(r.Azimuth), at });
  }
  return [...out.values()];
}

export async function buses(city: string, signal?: AbortSignal): Promise<Bus[]> {
  const rows = await tdxGet<TdxBus[]>(
    `/api/basic/v2/Bus/RealTimeByFrequency/City/${city}`,
    { $select: "PlateNumb,RouteName,BusPosition,Speed,Azimuth,GPSTime,DutyStatus,BusStatus" },
    signal,
  );
  return normalizeBuses(rows);
}

/** Cheapest call that proves a key works (one small city lot list). */
export async function testTdx(): Promise<string> {
  forgetTdxToken();
  await tdxToken();
  const rows = await tdxGet<{ CarParks?: unknown[] }>(`/api/basic/v1/Parking/OffStreet/CarPark/City/Tainan`, { $top: "1" });
  return Array.isArray(rows.CarParks) ? "TDX 金鑰可用" : "已登入，但回傳格式和預期不同";
}
