// Current 10 m wind on a coarse grid over the view (Open-Meteo, keyless).
// One request asks for every grid point at once.

import { FeedError, getJson } from "../lib/net";
import { parseTime } from "../lib/time";
import { num } from "../lib/util";

export interface WindGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  nx: number;
  ny: number;
  /** Eastward and northward components (m/s), row by row from the south. */
  u: Float32Array;
  v: Float32Array;
  maxSpeed: number;
  time: number | null;
}

export interface GridBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Grid points (lat, lng), south row first; at least 2×2. */
export function gridPoints(box: GridBox, nx: number, ny: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) out.push([box.south + ((box.north - box.south) * j) / (ny - 1), box.west + ((box.east - box.west) * i) / (nx - 1)]);
  return out;
}

/** Meteorological direction is where the wind comes from; u/v point where it goes. */
export function windVector(speed: number, fromDeg: number): [number, number] {
  const r = (fromDeg * Math.PI) / 180;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}

/** Bilinear wind at a point, or null outside the grid. */
export function sampleWind(g: WindGrid, lng: number, lat: number): [number, number] | null {
  const fx = ((lng - g.west) / (g.east - g.west)) * (g.nx - 1);
  const fy = ((lat - g.south) / (g.north - g.south)) * (g.ny - 1);
  if (!(fx >= 0 && fy >= 0 && fx <= g.nx - 1 && fy <= g.ny - 1)) return null;
  const i = Math.min(g.nx - 2, Math.floor(fx));
  const j = Math.min(g.ny - 2, Math.floor(fy));
  const tx = fx - i;
  const ty = fy - j;
  const at = (a: Float32Array, x: number, y: number) => a[y * g.nx + x];
  const lerp2 = (a: Float32Array) =>
    (at(a, i, j) * (1 - tx) + at(a, i + 1, j) * tx) * (1 - ty) + (at(a, i, j + 1) * (1 - tx) + at(a, i + 1, j + 1) * tx) * ty;
  return [lerp2(g.u), lerp2(g.v)];
}

interface OmRow {
  current?: { time?: number | string; wind_speed_10m?: number; wind_direction_10m?: number };
}

export function parseWindGrid(box: GridBox, nx: number, ny: number, rows: OmRow[] | OmRow): WindGrid {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length !== nx * ny) throw new FeedError("風場資料格數不符");
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  let maxSpeed = 0;
  list.forEach((r, k) => {
    const s = num(r.current?.wind_speed_10m) ?? 0;
    const d = num(r.current?.wind_direction_10m) ?? 0;
    [u[k], v[k]] = windVector(s, d);
    maxSpeed = Math.max(maxSpeed, s);
  });
  const t = list[0]?.current?.time;
  return { ...box, nx, ny, u, v, maxSpeed, time: typeof t === "number" ? t * 1000 : parseTime(t) };
}

export async function windGrid(box: GridBox, nx: number, ny: number, signal?: AbortSignal): Promise<WindGrid> {
  const pts = gridPoints(box, nx, ny);
  const q = new URLSearchParams({
    latitude: pts.map(([lat]) => lat.toFixed(2)).join(","),
    longitude: pts.map(([, lng]) => lng.toFixed(2)).join(","),
    current: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timeformat: "unixtime",
  });
  const rows = await getJson<OmRow[] | OmRow>(`https://api.open-meteo.com/v1/forecast?${q}`, { signal, timeout: 15000 });
  return parseWindGrid(box, nx, ny, rows);
}
