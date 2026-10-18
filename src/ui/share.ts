// "Share this view": a link that reopens the same camera, lenses, screen
// mode, map type and tracked target.
//   ?c=25.0331,121.5654&z=9.5&b=30&p=45&l=sky.weather&fx=nvg&m=g-sat&t=plane:8964a1

export interface SharedView {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
  lenses: string[];
  fx: string;
  map: string | null;
  track: { kind: "plane" | "sat"; id: string } | null;
}

const LENSES = new Set(["weather", "traffic", "parking", "sky"]);
const FX = new Set(["", "nvg", "flir", "ironbow", "crt", "noir", "snow"]);
const MAPS = new Set(["baiyan", "g-road", "g-dark", "g-sat", "g-terrain"]);
const round = (v: number, d: number) => Number(v.toFixed(d));

export function viewLink(base: string, v: SharedView): string {
  const q = new URLSearchParams();
  q.set("c", `${round(v.lat, 4)},${round(v.lng, 4)}`);
  q.set("z", String(round(v.zoom, 1)));
  if (Math.round(v.bearing)) q.set("b", String(Math.round(((v.bearing % 360) + 360) % 360)));
  if (Math.round(v.pitch)) q.set("p", String(Math.round(v.pitch)));
  if (v.lenses.length) q.set("l", v.lenses.join("."));
  if (v.fx) q.set("fx", v.fx);
  if (v.map) q.set("m", v.map);
  if (v.track) q.set("t", `${v.track.kind}:${v.track.id}`);
  return `${base}?${q.toString().replace(/%2C/g, ",").replace(/%3A/g, ":")}`;
}

/** The view a link describes, or null when the URL is not a view link. */
export function readViewLink(search: string): SharedView | null {
  const q = new URLSearchParams(search);
  const c = q.get("c")?.split(",").map(Number);
  if (!c || c.length !== 2 || !c.every(Number.isFinite) || Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180) return null;
  const n = (k: string, lo: number, hi: number, d: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  const t = q.get("t")?.match(/^(plane|sat):([0-9a-zA-Z~]{1,12})$/);
  return {
    lat: c[0],
    lng: c[1],
    zoom: n("z", 0, 22, 8),
    bearing: n("b", 0, 360, 0),
    pitch: n("p", 0, 70, 0),
    lenses: (q.get("l") ?? "").split(".").filter((l) => LENSES.has(l)),
    fx: FX.has(q.get("fx") ?? "") ? (q.get("fx") ?? "") : "",
    map: MAPS.has(q.get("m") ?? "") ? q.get("m") : null,
    track: t ? { kind: t[1] as "plane" | "sat", id: t[2].toLowerCase() } : null,
  };
}

/** The share sheet where there is one, else the clipboard. */
export async function shareLink(url: string, title: string, toast: (t: string) => void): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ title, url });
      return;
    }
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("已複製這個畫面的連結");
  } catch {
    prompt("複製這個連結：", url);
  }
}
