// Where the sun is overhead, and where on Earth it has set: the day/night
// line drawn on the globe, with twilight bands below it.

import { gstime } from "../lib/sgp4";
import type { Point } from "../lib/util";
import { sunEci } from "./passes";

const DEG = Math.PI / 180;

/** The point on Earth with the sun straight overhead. */
export function subsolarPoint(when: Date): Point {
  const s = sunEci(when);
  const r = Math.hypot(s.x, s.y, s.z);
  const lat = Math.asin(s.z / r) / DEG;
  const lng = ((((Math.atan2(s.y, s.x) - gstime(when)) / DEG + 540) % 360) + 360) % 360 - 180;
  return { lat, lng };
}

/**
 * Latitude along one meridian where the sun stands `elevation` degrees above
 * the horizon (0 = sunset line, −6/−12/−18 = civil/nautical/astronomical dusk).
 */
export function terminatorLat(sun: Point, lng: number, elevation = 0): number {
  // Keep away from the equinox singularity, where the line runs pole to pole.
  const d = (Math.abs(sun.lat) < 0.01 ? 0.01 * Math.sign(sun.lat || 1) : sun.lat) * DEG;
  const h = (lng - sun.lng) * DEG;
  const a = Math.sin(d);
  const b = Math.cos(d) * Math.cos(h);
  const r = Math.hypot(a, b);
  const s = Math.sin(elevation * DEG) / r;
  const dark = sun.lat >= 0 ? -90 : 90;
  // No point on this meridian is that far below the horizon: the band shrinks to the dark pole here.
  if (Math.abs(s) > 1) return dark;
  const phi = Math.atan2(b, a);
  const sunset = Math.atan(-Math.cos(h) / Math.tan(d));
  const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  const options = [wrap(Math.asin(s) - phi), wrap(Math.PI - Math.asin(s) - phi)].filter((x) => Math.abs(x) <= Math.PI / 2 + 1e-9);
  if (!options.length) return dark;
  return options.reduce((best, x) => (Math.abs(x - sunset) < Math.abs(best - sunset) ? x : best)) / DEG;
}

/**
 * The region where the sun is below `elevation`, as one polygon ring: a circle
 * of radius 90° + elevation around the point opposite the sun. When it takes
 * in the dark pole (always for the sunset line, for the dusk lines once the
 * sun is far enough from the equator) every meridian crosses it once, so the
 * ring follows the line meridian by meridian and closes over that pole.
 * Otherwise it is an island, drawn as the circle itself.
 */
export function nightRing(sun: Point, elevation = 0, step = 2): Array<[number, number]> {
  const anti = { lat: -sun.lat, lng: sun.lng > 0 ? sun.lng - 180 : sun.lng + 180 };
  const radius = 90 + elevation;
  const pole = anti.lat <= 0 ? -90 : 90;
  const ring: Array<[number, number]> = [];
  if (90 - Math.abs(anti.lat) < radius) {
    for (let lng = -180; lng <= 180; lng += step) ring.push([lng, terminatorLat(sun, lng, elevation)]);
    ring.push([180, pole], [-180, pole], ring[0]);
    return ring;
  }
  const a = anti.lat * DEG;
  const d = radius * DEG;
  let prev: number | null = null;
  for (let b = 0; b <= 360; b += step) {
    const t = b * DEG;
    const lat = Math.asin(Math.sin(a) * Math.cos(d) + Math.cos(a) * Math.sin(d) * Math.cos(t));
    let lng = anti.lng + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(a), Math.cos(d) - Math.sin(a) * Math.sin(lat)) / DEG;
    // Keep longitudes continuous across the antimeridian; the map wraps them.
    if (prev !== null) lng += Math.round((prev - lng) / 360) * 360;
    ring.push([lng, lat / DEG]);
    prev = lng;
  }
  ring[ring.length - 1] = ring[0];
  return ring;
}

/** Degrees the sun stands above the horizon at a point (for tests and labels). */
export function sunAltitude(sun: Point, p: Point): number {
  const d = sun.lat * DEG;
  const lat = p.lat * DEG;
  const h = (p.lng - sun.lng) * DEG;
  return Math.asin(Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(h)) / DEG;
}
