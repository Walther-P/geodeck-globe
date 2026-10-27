// TDX (交通部運輸資料流通服務) with the visitor's own client id/secret.
// Field names follow the MOTC transport data standard; every reader below
// tolerates missing fields because city feeds differ in completeness.

import { FeedError, getJson } from "../lib/net";
import { read, remove, write } from "../lib/store";
import { parseTime } from "../lib/time";
import { num, point, safeUrl } from "../lib/util";
import { headingFromName, viewHeading, type HeadingKind } from "./heading";
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

// A free TDX key gets about five data calls a minute (measured 2026-10-18:
// the sixth within a minute answers 429 with Retry-After ≈ 20 s). Every call
// waits its turn in one queue that keeps to that budget and honours
// Retry-After; what the visitor is waiting on most goes first.
const BUDGET = 5;
const WINDOW_MS = 60000;
const SPACING_MS = 500;
/** Lower goes first; equal priorities keep their order. */
export const PRIORITY = { parking: 0, buses: 1, lists: 2 } as const;
const jobs: Array<{ priority: number; start: () => void }> = [];
let pumping = false;
let recent: number[] = [];
let blockedUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the next call must wait, given the start times of recent calls (oldest first). */
export function budgetWait(now: number, calls: number[], until = 0): number {
  const inWindow = calls.filter((t) => t > now - WINDOW_MS);
  const full = inWindow.length >= BUDGET ? inWindow[inWindow.length - BUDGET] + WINDOW_MS - now : 0;
  return Math.max(0, until - now, full, (inWindow.at(-1) ?? -Infinity) + SPACING_MS - now);
}

function paced<T>(fn: () => Promise<T>, priority: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobs.push({ priority, start: () => fn().then(resolve, reject) });
    jobs.sort((a, z) => a.priority - z.priority);
    void pump();
  });
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  while (jobs.length) {
    for (;;) {
      const now = Date.now();
      recent = recent.filter((t) => t > now - WINDOW_MS);
      const wait = budgetWait(now, recent, blockedUntil);
      if (wait <= 0) break;
      await sleep(wait);
    }
    recent.push(Date.now());
    jobs.shift()!.start();
  }
  pumping = false;
}

export async function tdxGet<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal, priority: number = PRIORITY.lists): Promise<T> {
  const url = `${TDX_BASE}${path}?${new URLSearchParams({ $format: "JSON", ...params })}`;
  const attempt = async () => {
    const token = await tdxToken();
    return paced(
      () =>
        getJson<T>(url, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          // TDX doesn't allow browser reads (no CORS), so always via our relay.
          route: "relay",
          timeout: 20000,
          signal,
        }),
      priority,
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
    // Over the limit anyway (another tab, another device on this key): hold
    // every TDX call until TDX says, then try this one once more.
    if (e instanceof FeedError && e.status === 429 && !signal?.aborted) {
      blockedUntil = Math.max(blockedUntil, Date.now() + (e.retryAfter ?? 20) * 1000);
      return attempt().catch((again: unknown) => {
        throw again instanceof FeedError && again.status === 429 ? new FeedError("TDX 免費額度每分鐘只能讀幾次，稍後自動更新", 429) : again;
      });
    }
    throw e;
  }
}

// Positions, names and camera lists barely change while counts change every
// minute, so the static lists are kept for hours, also across app restarts
// (when small enough for storage): a refresh then costs one call per feed.
const STATIC_MS = 6 * 3600000;
const STATIC_STORAGE = "gdg.tdx.static.v1:";
const STATIC_INDEX = "gdg.tdx.static.index.v1";
// Small enough that cached lists can never crowd out the visitor's own keys.
const STATIC_MAX_CHARS = 400_000;
const STATIC_MAX_ENTRIES = 4;
const staticLists = new Map<string, { at: number; data: Promise<unknown> }>();

function tdxStatic<T>(path: string, params: Record<string, string> = {}, priority: number = PRIORITY.lists): Promise<T> {
  const key = `${path}?${new URLSearchParams(params)}`;
  const hit = staticLists.get(key);
  if (hit && Date.now() - hit.at < STATIC_MS) return hit.data as Promise<T>;
  const stored = read<{ at: number; data: T } | null>(STATIC_STORAGE + key, null);
  if (stored && Date.now() - stored.at < STATIC_MS) {
    staticLists.set(key, { at: stored.at, data: Promise.resolve(stored.data) });
    return Promise.resolve(stored.data);
  }
  const data = tdxGet<T>(path, params, undefined, priority);
  const at = Date.now();
  staticLists.set(key, { at, data });
  data.then(
    (d) => keepStatic(key, at, d),
    () => staticLists.delete(key),
  );
  return data;
}

function keepStatic(key: string, at: number, data: unknown): void {
  const entry = { at, data };
  if (JSON.stringify(entry).length > STATIC_MAX_CHARS) return;
  // Newest first; the oldest beyond the limit are dropped.
  const index = [key, ...read<string[]>(STATIC_INDEX, []).filter((k) => k !== key)];
  for (const old of index.splice(STATIC_MAX_ENTRIES)) remove(STATIC_STORAGE + old);
  write(STATIC_INDEX, index);
  write(STATIC_STORAGE + key, entry);
}

/** A feed's row array, whatever this version of the feed calls it ("…Availabilities"). */
function rowsOf<T>(data: unknown, suffix: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (!data || typeof data !== "object") return [];
  for (const [k, v] of Object.entries(data)) if (k.endsWith(suffix) && Array.isArray(v)) return v as T[];
  return [];
}

const zh = (v: unknown): string => {
  if (typeof v === "string") return v;
  const o = v as { Zh_tw?: string; Zh_TW?: string; En?: string } | null;
  return o?.Zh_tw ?? o?.Zh_TW ?? o?.En ?? "";
};

// ---- Parking -------------------------------------------------------------

export interface LiveLot {
  id: string;
  /** "curb" = a kerbside segment (路邊), counted as a whole. */
  kind: "lot" | "curb";
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
  /** "tdx" (the visitor's own key) or the city whose open feed this came from. */
  source: "tdx" | "taipei" | "taoyuan" | "taichung";
  /** How old a count may be and still be shown; LIVE_MAX_AGE_MS unless the source publishes less often. */
  maxAgeMs?: number;
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
      kind: "lot",
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
    tdxStatic<{ CarParks?: TdxCarPark[] }>(
      `/api/basic/v1/Parking/OffStreet/CarPark/City/${city}`,
      { $select: "CarParkID,CarParkName,CarParkPosition,Address,FareDescription" },
      PRIORITY.parking,
    ),
    tdxGet<{ ParkingAvailabilities?: TdxAvailability[] }>(`/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/${city}`, {}, signal, PRIORITY.parking),
  ]);
  return normalizeLiveLots(parks, avail, city);
}

// ---- Kerbside (路邊) segments ----------------------------------------------

interface TdxSegment {
  ParkingSegmentID?: string;
  ParkingSegmentName?: unknown;
  ParkingSegmentPosition?: unknown;
  FareDescription?: string;
}

type TdxSegmentAvailability = TdxAvailability & { ParkingSegmentID?: string; ParkingSegmentName?: unknown };

/** A segment's position: a PointType, or the middle vertex of a WKT line ("lng lat, …"). */
export function segmentPoint(v: unknown): { lat: number; lng: number } | null {
  if (typeof v === "string") {
    const pairs = [...v.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
    const mid = pairs[Math.floor(pairs.length / 2)];
    return mid ? point(mid[2], mid[1]) : null;
  }
  const o = v as { PositionLat?: number; PositionLon?: number } | null;
  return point(o?.PositionLat, o?.PositionLon);
}

/** Only segments the city reports counts for; the bundled catalog has the rest. */
export function normalizeCurbs(segments: unknown, availability: unknown, city: string): LiveLot[] {
  const feedTime = Array.isArray(availability) ? null : parseTime((availability as { UpdateTime?: string } | null)?.UpdateTime);
  const byId = new Map(
    rowsOf<TdxSegmentAvailability>(availability, "Availabilities")
      .filter((r) => r.ParkingSegmentID)
      .map((r) => [r.ParkingSegmentID!, r]),
  );
  const out: LiveLot[] = [];
  for (const s of rowsOf<TdxSegment>(segments, "Segments")) {
    const a = s.ParkingSegmentID ? byId.get(s.ParkingSegmentID) : undefined;
    const pos = segmentPoint(s.ParkingSegmentPosition);
    if (!a || !pos) continue;
    const car = a.Availabilities?.find((x) => x.SpaceType === 1);
    const available = count(car?.AvailableSpaces ?? a.AvailableSpaces);
    out.push({
      id: `tdx-${city}-curb-${s.ParkingSegmentID}`,
      kind: "curb",
      name: zh(s.ParkingSegmentName) || zh(a.ParkingSegmentName) || "路邊停車",
      ...pos,
      total: count(car?.NumberOfSpaces ?? a.TotalSpaces),
      available: a.ServiceStatus === 0 ? null : available,
      updatedAt: parseTime(a.DataCollectTime) ?? feedTime,
      full: a.FullStatus === 1 || available === 0,
      address: "",
      fare: s.FareDescription ?? "",
      city,
      source: "tdx",
    });
  }
  return out;
}

export async function liveCurbs(city: string, signal?: AbortSignal): Promise<LiveLot[]> {
  const [segments, avail] = await Promise.all([
    tdxStatic(
      `/api/basic/v1/Parking/OnStreet/ParkingSegment/City/${city}`,
      { $select: "ParkingSegmentID,ParkingSegmentName,ParkingSegmentPosition,FareDescription" },
      PRIORITY.parking,
    ),
    tdxGet(`/api/basic/v1/Parking/OnStreet/ParkingSegmentAvailability/City/${city}`, {}, signal, PRIORITY.parking),
  ]);
  return normalizeCurbs(segments, avail, city);
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
  /** Seconds between reloads when `image` is a still; without it `image` is a live stream. */
  refreshS?: number;
  /** HLS video, for browsers that play it natively (Safari, iPhone). */
  video?: string | null;
  /** A short recorded clip (mp4). */
  clip?: string | null;
  /** Other directions from the same pole. */
  views?: Array<{ label: string; image: string }>;
  /** For feeds whose image URL changes every frame: the newest one. */
  latest?: () => Promise<string | null>;
  /** Degrees clockwise from north: where the camera looks ("view"), or the direction of travel of the carriageway it watches ("lanes"). */
  heading?: number | null;
  headingKind?: HeadingKind;
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
      // City cameras often say where they look ("往北"); RoadDirection is only the carriageway.
      ...viewHeading(headingFromName(name)),
    });
  }
  return out;
}

export async function cctv(scope: "Freeway" | "Highway" | string): Promise<Camera[]> {
  const path = scope === "Freeway" || scope === "Highway" ? `/api/basic/v2/Road/Traffic/CCTV/${scope}` : `/api/basic/v2/Road/Traffic/CCTV/City/${scope}`;
  return normalizeCctv(await tdxStatic<{ CCTVs?: TdxCctv[] }>(path), scope);
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
    PRIORITY.buses,
  );
  return normalizeBuses(rows);
}

/** Cheapest call that proves a key works (one small city lot list). */
export async function testTdx(): Promise<string> {
  forgetTdxToken();
  await tdxToken();
  const rows = await tdxGet<{ CarParks?: unknown[] }>(`/api/basic/v1/Parking/OffStreet/CarPark/City/Tainan`, { $top: "1" }, undefined, PRIORITY.parking);
  return Array.isArray(rows.CarParks) ? "TDX 金鑰可用" : "已登入，但回傳格式和預期不同";
}
