export interface Point {
  lat: number;
  lng: number;
}

export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function num(v: unknown): number | null {
  if (finite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function validPoint(p: unknown): p is Point {
  const q = p as Point | null;
  return !!q && finite(q.lat) && finite(q.lng) && Math.abs(q.lat) <= 90 && Math.abs(q.lng) <= 180;
}

export function point(lat: unknown, lng: unknown): Point | null {
  const p = { lat: num(lat) ?? NaN, lng: num(lng) ?? NaN };
  // Several feeds use 0,0 for "no fix".
  return validPoint(p) && !(p.lat === 0 && p.lng === 0) ? p : null;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distance(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function formatDistance(m: number): string {
  if (!finite(m)) return "—";
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function inBounds(p: Point, b: Bounds): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

export function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Only http(s) links from feeds may become href/src attributes. */
export function safeUrl(v: unknown, { httpsOnly = false } = {}): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol === "https:" || (!httpsOnly && u.protocol === "http:")) return u.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

export function parseCoordinates(text: string): Point | null {
  const m = text.trim().match(/^(?:geo:)?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,，\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const p = { lat: Number(m[1]), lng: Number(m[2]) };
  return validPoint(p) ? p : null;
}

export function formatCoord(p: Point, digits = 4): string {
  const ns = p.lat >= 0 ? "N" : "S";
  const ew = p.lng >= 0 ? "E" : "W";
  return `${Math.abs(p.lat).toFixed(digits)}°${ns} ${Math.abs(p.lng).toFixed(digits)}°${ew}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Circle as a polygon, close enough for radii of metres to hundreds of km. */
export function circlePolygon(lng: number, lat: number, km: number, properties: Record<string, unknown> = {}, steps = 64): GeoJSON.Feature {
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const dLat = (km / 111.32) * Math.cos(a);
    const dLng = (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a);
    coords.push([lng + dLng, lat + dLat]);
  }
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [coords] } };
}
