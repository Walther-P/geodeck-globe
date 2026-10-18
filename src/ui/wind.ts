// Wind particles: thousands of short-lived tracers drift with the current
// wind and leave fading trails, coloured by speed, on a canvas over the map.

import { sampleWind, type WindGrid } from "../data/wind";
import type { GlobeMap } from "../map/globe";

const FRAME_MS = 33;
/** Screen pixels per frame for each m/s of wind. */
const PX_PER_MS = 0.28;
const RAD = Math.PI / 180;

interface Particle {
  lng: number;
  lat: number;
  age: number;
  life: number;
}

function speedColor(s: number): string {
  if (s < 3) return "rgba(125, 211, 252, 0.75)";
  if (s < 7) return "rgba(94, 234, 212, 0.85)";
  if (s < 12) return "rgba(251, 191, 36, 0.9)";
  if (s < 18) return "rgba(249, 115, 22, 0.95)";
  return "rgba(248, 113, 113, 1)";
}

export class WindLayer {
  private canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d");
  private grid: WindGrid | null = null;
  private particles: Particle[] = [];
  private raf = 0;
  private last = 0;
  private moving = false;

  constructor(private map: GlobeMap) {
    this.canvas.className = "wind hidden";
    this.canvas.setAttribute("aria-hidden", "true");
    map.getContainer().parentElement!.append(this.canvas);
    map.on("movestart", () => (this.moving = true));
    map.on("moveend", () => {
      this.moving = false;
      this.reseed();
    });
  }

  show(grid: WindGrid): void {
    this.grid = grid;
    this.canvas.classList.remove("hidden");
    this.reseed();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }

  hide(): void {
    this.grid = null;
    cancelAnimationFrame(this.raf);
    this.canvas.classList.add("hidden");
    this.g?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private reseed(): void {
    if (!this.grid) return;
    const rect = this.map.getContainer().getBoundingClientRect();
    const count = Math.round(Math.min(1800, Math.max(500, (rect.width * rect.height) / 240)));
    this.particles = Array.from({ length: count }, () => this.spawn(Math.random() * 90));
    this.g?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private spawn(age = 0): Particle {
    const b = this.map.getBounds();
    const g = this.grid!;
    // Inside both the view and the grid we have data for.
    const west = Math.max(b.getWest(), g.west);
    const east = Math.min(b.getEast(), g.east);
    const south = Math.max(b.getSouth(), g.south);
    const north = Math.min(b.getNorth(), g.north);
    const ok = east > west && north > south;
    return {
      lng: ok ? west + Math.random() * (east - west) : g.west + Math.random() * (g.east - g.west),
      lat: ok ? south + Math.random() * (north - south) : g.south + Math.random() * (g.north - g.south),
      age,
      life: 60 + Math.random() * 60,
    };
  }

  private frame = (time: number): void => {
    if (!this.grid) return;
    this.raf = requestAnimationFrame(this.frame);
    if (time - this.last < FRAME_MS) return;
    this.last = time;
    const g = this.g;
    if (!g) return;
    const rect = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(rect.width * dpr) || this.canvas.height !== Math.round(rect.height * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.moving) {
      // Trails would smear while the map moves; start them again when it stops.
      g.clearRect(0, 0, rect.width, rect.height);
      return;
    }
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = "rgba(0, 0, 0, 0.92)";
    g.fillRect(0, 0, rect.width, rect.height);
    g.globalCompositeOperation = "source-over";
    g.lineWidth = 1.3;
    g.lineCap = "round";
    const worldPxPerDeg = (512 * 2 ** this.map.getZoom()) / 360;
    const c = this.map.getCenter();
    const hemisphere = this.map.getZoom() < 6;
    for (let k = 0; k < this.particles.length; k++) {
      const p = this.particles[k];
      const w = sampleWind(this.grid, p.lng, p.lat);
      if (!w || ++p.age > p.life || (hemisphere && farSide(c.lat, c.lng, p.lat, p.lng))) {
        this.particles[k] = this.spawn();
        continue;
      }
      const [u, v] = w;
      const speed = Math.hypot(u, v);
      const a = this.map.project([p.lng, p.lat]);
      // Web Mercator: x pixels map 1:1 to longitude, y pixels shrink by cos(latitude).
      p.lng += (u * PX_PER_MS) / worldPxPerDeg;
      p.lat += ((v * PX_PER_MS) / worldPxPerDeg) * Math.cos(p.lat * RAD);
      const b = this.map.project([p.lng, p.lat]);
      if (Math.abs(b.x - a.x) > 40 || Math.abs(b.y - a.y) > 40) continue;
      g.strokeStyle = speedColor(speed);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  };
}

/** Beyond the visible hemisphere of the globe. */
function farSide(lat0: number, lng0: number, lat: number, lng: number): boolean {
  return Math.sin(lat0 * RAD) * Math.sin(lat * RAD) + Math.cos(lat0 * RAD) * Math.cos(lat * RAD) * Math.cos((lng - lng0) * RAD) < 0.2;
}
