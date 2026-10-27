// Which way a road camera looks, for the fan drawn under its icon. Only what
// the operator says: a direction in the camera's name or a field in its feed.
// Freeway cameras in Taiwan only say which carriageway they watch ("南向"),
// so for those the fan follows that carriageway's direction of travel along
// the road (worked out from the neighbouring cameras), and is drawn as such.

import { distance, type Point } from "../lib/util";

export type HeadingKind = "view" | "lanes";

const ZH: Record<string, number> = { 北: 0, 東北: 45, 東: 90, 東南: 135, 南: 180, 西南: 225, 西: 270, 西北: 315 };
const EN: Record<string, number> = {
  n: 0,
  north: 0,
  nne: 22.5,
  ne: 45,
  northeast: 45,
  ene: 67.5,
  e: 90,
  east: 90,
  ese: 112.5,
  se: 135,
  southeast: 135,
  sse: 157.5,
  s: 180,
  south: 180,
  ssw: 202.5,
  sw: 225,
  southwest: 225,
  wsw: 247.5,
  w: 270,
  west: 270,
  wnw: 292.5,
  nw: 315,
  northwest: 315,
  nnw: 337.5,
};

/** "北", "東南", "N", "NorthEast", "south east", "Northbound" → degrees clockwise from north. */
export function compassDeg(word: string | null | undefined): number | null {
  const w = (word ?? "").trim();
  if (w in ZH) return ZH[w];
  const key = w
    .toLowerCase()
    .replace(/bound$/, "")
    .replace(/[\s_-]+/g, "");
  return key in EN ? EN[key] : null;
}

/**
 * The direction a camera looks, when its name says so: "南桿(向北)", "路口往西",
 * "往南方向全景", "looking north", "facing SE". Not "車行往北" (that is traffic).
 */
export function headingFromName(name: string): number | null {
  // No lookbehind: older iPhones' Safari cannot parse it.
  for (const m of name.matchAll(/(車行|車流)?(?:向|往|朝)(東北|東南|西北|西南|北|南|東|西)(?=方向|向|側|邊|[)）]|$|\s|[-－、，,])/g)) if (!m[1]) return ZH[m[2]];
  const en = name.match(/\b(?:looking|facing|view(?:ing)?|towards?)\s+(north[\s-]?east|north[\s-]?west|south[\s-]?east|south[\s-]?west|north|south|east|west|ne|nw|se|sw|n|s|e|w)\b/i);
  return en ? compassDeg(en[1]) : null;
}

export function bearing(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
}

const turn = (a: number, b: number) => Math.abs((((b - a) % 360) + 540) % 360 - 180);

/** "n1-s-181k-320" → road n1, southbound, kilometre 181.32. Also "n5-s-11k-873", "t2f-n-0k-524". */
export function freewayRef(id: string): { road: string; dir: "n" | "s" | "e" | "w"; km: number } | null {
  const m = id.match(/^([nt]\d+[a-z]?)-([nsew])-(\d+)k-(\d+)/);
  return m ? { road: m[1], dir: m[2] as "n" | "s" | "e" | "w", km: Number(m[3]) + Number(m[4]) / 1000 } : null;
}

/**
 * Direction of travel of the carriageway each freeway camera watches, from
 * the cameras before and after it on the same road and carriageway. Whether
 * kilometres count up or down along "南向" is decided once per road by
 * majority, so a bend that briefly runs north does not flip the fan.
 */
export function laneHeadings<T extends Point & { id: string }>(cams: T[]): Map<string, number> {
  const groups = new Map<string, Array<{ cam: T; km: number; dir: number }>>();
  for (const cam of cams) {
    const ref = freewayRef(cam.id);
    if (!ref) continue;
    const key = `${ref.road}-${ref.dir}`;
    groups.set(key, [...(groups.get(key) ?? []), { cam, km: ref.km, dir: compassDeg(ref.dir)! }]);
  }
  const out = new Map<string, number>();
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.km - b.km);
    // Up the kilometres: is that the way this carriageway runs?
    let votes = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = distance(rows[i - 1].cam, rows[i].cam);
      if (d < 50 || d > 5000) continue;
      votes += turn(bearing(rows[i - 1].cam, rows[i].cam), rows[0].dir) < 90 ? 1 : -1;
    }
    if (!votes) continue;
    const up = votes > 0;
    rows.forEach((r, i) => {
      // The nearest neighbours at least 100 m away on each side, within 5 km.
      let a = i;
      let b = i;
      while (a > 0 && distance(rows[a].cam, r.cam) < 100) a--;
      while (b < rows.length - 1 && distance(rows[b].cam, r.cam) < 100) b++;
      const from = rows[a].cam;
      const to = rows[b].cam;
      if (from === to || distance(from, to) > 10000) return;
      const axis = bearing(from, to);
      out.set(r.cam.id, Math.round(up ? axis : (axis + 180) % 360));
    });
  }
  return out;
}

/** Spread into a Camera: nothing when there is no heading. */
export function viewHeading(deg: number | null | undefined): { heading?: number; headingKind?: HeadingKind } {
  return deg === null || deg === undefined ? {} : { heading: deg, headingKind: "view" };
}

/** Icelandic captions say "séð til vesturs" (seen towards the west). */
const IS: Record<string, number> = { norðurs: 0, norðausturs: 45, austurs: 90, suðausturs: 135, suðurs: 180, suðvesturs: 225, vesturs: 270, norðvesturs: 315 };
export function icelandicHeading(text: string | null | undefined): number | null {
  const m = (text ?? "").toLowerCase().match(/séð til (\S+?)[\s,.]|séð til (\S+)$/);
  const w = m?.[1] ?? m?.[2];
  return w && w in IS ? IS[w] : null;
}

/** New Zealand describes each view as "South along Hinds Highway…", "North-west from…". */
export function leadingCompass(text: string | null | undefined): number | null {
  const m = (text ?? "").trim().match(/^(north|south|east|west)(?:[\s-]?(east|west))?\b/i);
  return m ? compassDeg(`${m[1]}${m[2] ?? ""}`) : null;
}

/** Names for the card: "北", "東北"… */
export function compassName(deg: number): string {
  return ["北", "東北", "東", "東南", "南", "西南", "西", "西北"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
