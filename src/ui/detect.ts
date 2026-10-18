// Detection HUD: corner-bracket boxes with target numbers and live data on
// the aircraft and satellites in view, drawn on a canvas over the map.

import type { GlobeMap } from "../map/globe";

export interface Detectable {
  id: string;
  kind: "plane" | "sat";
  lat: number;
  lng: number;
  label: string;
  sub: string;
}

const MAX_BOXES = 36;
const FRAME_MS = 66;
const COLORS = { plane: "#fbbf24", sat: "#5eead4", lock: "#f87171" };
const RAD = Math.PI / 180;

/** Angle (degrees) between two points on the globe, to skip the far side. */
function arc(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const c = Math.sin(a.lat * RAD) * Math.sin(b.lat * RAD) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((a.lng - b.lng) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, c))) / RAD;
}

export class DetectOverlay {
  private canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d");
  private on = false;
  private raf = 0;
  private last = 0;
  private numbers = new Map<string, number>();

  constructor(
    private map: GlobeMap,
    private objects: () => Detectable[],
    private lockedId: () => string | null,
  ) {
    this.canvas.className = "detect";
    this.canvas.setAttribute("aria-hidden", "true");
    map.getContainer().parentElement!.append(this.canvas);
  }

  set(on: boolean): void {
    this.on = on;
    this.canvas.classList.toggle("hidden", !on);
    cancelAnimationFrame(this.raf);
    if (on) this.raf = requestAnimationFrame(this.frame);
    else this.g?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private frame = (time: number): void => {
    if (!this.on) return;
    this.raf = requestAnimationFrame(this.frame);
    if (time - this.last < FRAME_MS) return;
    this.last = time;
    this.draw();
  };

  private draw(): void {
    const g = this.g;
    if (!g) return;
    const rect = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(rect.width * dpr) || this.canvas.height !== Math.round(rect.height * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rect.width, rect.height);
    const c = this.map.getCenter();
    const center = { lat: c.lat, lng: c.lng };
    // Low zooms show the whole globe; only the near hemisphere is visible.
    const horizon = this.map.getZoom() < 6 ? 78 : 180;
    const locked = this.lockedId();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const seen = this.objects()
      .filter((o) => horizon === 180 || arc(center, o) < horizon)
      .map((o) => ({ o, p: this.map.project([o.lng, o.lat]) }))
      .filter(({ p }) => p.x > -20 && p.y > -20 && p.x < rect.width + 20 && p.y < rect.height + 20)
      .sort((a, z) => Math.hypot(a.p.x - cx, a.p.y - cy) - Math.hypot(z.p.x - cx, z.p.y - cy))
      .slice(0, MAX_BOXES);
    g.font = '600 10px "SF Mono", ui-monospace, Menlo, monospace';
    g.textBaseline = "top";
    for (const { o, p } of seen) {
      if (!this.numbers.has(o.id)) this.numbers.set(o.id, this.numbers.size + 1);
      const isLock = o.id === locked;
      const color = isLock ? COLORS.lock : COLORS[o.kind];
      const half = isLock ? 22 : o.kind === "plane" ? 15 : 12;
      bracket(g, p.x, p.y, half, color, isLock ? 2 : 1.3);
      const tag = `${isLock ? "LOCK " : ""}TGT-${String(this.numbers.get(o.id)).padStart(2, "0")} ${o.label}`;
      const tx = p.x + half + 4;
      const ty = p.y - half;
      const w = Math.max(g.measureText(tag).width, g.measureText(o.sub).width) + 6;
      g.fillStyle = "rgba(4, 8, 13, 0.6)";
      g.fillRect(tx - 3, ty - 2, w, o.sub ? 26 : 14);
      g.fillStyle = color;
      g.fillText(tag, tx, ty);
      if (o.sub) {
        g.fillStyle = "rgba(219, 231, 239, 0.85)";
        g.fillText(o.sub, tx, ty + 12);
      }
    }
  }
}

function bracket(g: CanvasRenderingContext2D, x: number, y: number, h: number, color: string, width: number): void {
  const l = Math.max(5, h * 0.45);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const cx = x + sx * h;
    const cy = y + sy * h;
    g.moveTo(cx, cy - sy * l);
    g.lineTo(cx, cy);
    g.lineTo(cx - sx * l, cy);
  }
  g.stroke();
}
