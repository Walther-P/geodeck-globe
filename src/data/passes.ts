// When satellites fly over the observer, and whether they can be seen with
// the naked eye: the sky must be dark (sun 6° or more below the horizon) while
// the satellite is still in sunlight. Same SGP4 elements as the map.

import { ecfToLookAngles, eciToEcf, gstime, propagate } from "../lib/sgp4";
import type { Point } from "../lib/util";
import type { Satellite } from "./sky";

const R_EARTH_KM = 6371;
const AU_KM = 149597870.7;
const DEG = Math.PI / 180;

/** Well-known names for the famous few. */
export const SAT_NAMES: Record<string, string> = {
  "25544": "國際太空站",
  "48274": "天宮太空站",
  "20580": "哈伯太空望遠鏡",
};

export const satLabel = (s: Pick<Satellite, "id" | "name">) => SAT_NAMES[s.id] ?? s.name;

interface Vec {
  x: number;
  y: number;
  z: number;
}

/** The sun's position in the same equatorial (ECI) frame as SGP4, km. Low precision (~0.01°). */
export function sunEci(when: Date): Vec {
  const n = when.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = (280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const epsilon = (23.439 - 0.0000004 * n) * DEG;
  const r = AU_KM * (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g));
  return { x: r * Math.cos(lambda), y: r * Math.cos(epsilon) * Math.sin(lambda), z: r * Math.sin(epsilon) * Math.sin(lambda) };
}

const site = (p: Point) => ({ latitude: p.lat * DEG, longitude: p.lng * DEG, height: 0.05 });

/** Degrees the sun is above (+) or below (−) the observer's horizon. */
export function sunElevation(observer: Point, when: Date): number {
  const ecf = eciToEcf(sunEci(when), gstime(when));
  return ecfToLookAngles(site(observer), ecf).elevation / DEG;
}

/** Outside Earth's (cylindrical) shadow. */
export function sunlit(sat: Vec, sun: Vec): boolean {
  const len = Math.hypot(sun.x, sun.y, sun.z);
  const s = { x: sun.x / len, y: sun.y / len, z: sun.z / len };
  const along = sat.x * s.x + sat.y * s.y + sat.z * s.z;
  if (along > 0) return true;
  const px = sat.x - along * s.x;
  const py = sat.y - along * s.y;
  const pz = sat.z - along * s.z;
  return Math.hypot(px, py, pz) > R_EARTH_KM;
}

export interface Pass {
  id: string;
  name: string;
  rise: number;
  set: number;
  peak: number;
  maxElevation: number;
  riseAzimuth: number;
  setAzimuth: number;
  /** Dark sky and the satellite in sunlight at some point of the pass. */
  visible: boolean;
}

function lookAt(s: Satellite, observer: Point, t: number): { el: number; az: number; eci: Vec } | null {
  const when = new Date(t);
  const pv = propagate(s.satrec, when);
  if (!pv || typeof pv.position !== "object") return null;
  const a = ecfToLookAngles(site(observer), eciToEcf(pv.position, gstime(when)));
  return { el: a.elevation / DEG, az: ((a.azimuth / DEG) % 360 + 360) % 360, eci: pv.position };
}

/** Time (±2 s) at which elevation crosses `minEl` between a (below) and b (above), or the reverse. */
function crossing(s: Satellite, observer: Point, a: number, b: number, minEl: number): number {
  let lo = a;
  let hi = b;
  const aboveAtLo = (lookAt(s, observer, lo)?.el ?? -90) >= minEl;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const above = (lookAt(s, observer, mid)?.el ?? -90) >= minEl;
    if (above === aboveAtLo) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

/** Passes above `minEl` degrees in the next `hours`, scanned once a minute and refined. */
export function passesOf(s: Satellite, observer: Point, from: number, hours: number, minEl = 10): Pass[] {
  const out: Pass[] = [];
  const step = 60000;
  const end = from + hours * 3600000;
  let prev = lookAt(s, observer, from);
  let open: Pass | null = prev && prev.el >= minEl ? newPass(s, from, prev) : null;
  for (let t = from + step; t <= end; t += step) {
    const cur = lookAt(s, observer, t);
    if (!cur) continue;
    const wasUp = (prev?.el ?? -90) >= minEl;
    const isUp = cur.el >= minEl;
    if (!wasUp && isUp) {
      const rise = crossing(s, observer, t - step, t, minEl);
      open = newPass(s, rise, lookAt(s, observer, rise) ?? cur);
    }
    if (open && isUp) {
      if (cur.el > open.maxElevation) {
        open.maxElevation = cur.el;
        open.peak = t;
      }
      if (!open.visible) open.visible = isVisible(observer, t, cur.eci);
    }
    if (open && wasUp && !isUp) {
      open.set = crossing(s, observer, t - step, t, minEl);
      open.setAzimuth = lookAt(s, observer, open.set)?.az ?? cur.az;
      out.push(open);
      open = null;
    }
    prev = cur;
  }
  return out;
}

function newPass(s: Satellite, rise: number, at: { el: number; az: number }): Pass {
  return { id: s.id, name: satLabel(s), rise, set: rise, peak: rise, maxElevation: at.el, riseAzimuth: at.az, setAzimuth: at.az, visible: false };
}

function isVisible(observer: Point, t: number, eci: Vec): boolean {
  const when = new Date(t);
  return sunElevation(observer, when) < -6 && sunlit(eci, sunEci(when));
}

/**
 * Upcoming passes for the famous stations (every pass) and other bright
 * satellites (only high, naked-eye ones), sorted by time. Yields between
 * satellites so the page stays responsive on phones.
 */
export async function upcomingPasses(famous: Satellite[], bright: Satellite[], observer: Point, from = Date.now()): Promise<Pass[]> {
  const out: Pass[] = [];
  for (const s of famous) {
    out.push(...passesOf(s, observer, from, 48));
    await new Promise((r) => setTimeout(r, 0));
  }
  const seen = new Set(famous.map((s) => s.id));
  for (const s of bright) {
    if (seen.has(s.id)) continue;
    out.push(...passesOf(s, observer, from, 24, 10).filter((p) => p.visible && p.maxElevation >= 40));
    await new Promise((r) => setTimeout(r, 0));
  }
  return out.sort((a, z) => a.rise - z.rise);
}

const icsTime = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (v: string) => v.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

/** A calendar entry (with a 5-minute alarm) for one pass. */
export function passIcs(p: Pass, description: string, now = Date.now()): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Baiyan//Satellite passes//ZH",
    "BEGIN:VEVENT",
    `UID:${p.id}-${p.rise}@baiyan`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(p.rise)}`,
    `DTEND:${icsTime(Math.max(p.set, p.rise + 60000))}`,
    `SUMMARY:${icsText(`${p.name}過境（最高 ${Math.round(p.maxElevation)}°）`)}`,
    `DESCRIPTION:${icsText(description)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT5M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(`${p.name} 5 分鐘後過境`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
