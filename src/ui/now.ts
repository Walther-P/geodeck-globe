// "此刻" bar: one line answering "anything I should know right now?" for my
// position (after locating) or the map centre.

import { warnings, type Warning } from "../data/cwa";
import { hasCwa, onKeysChange } from "../data/keys";
import { usgsQuakes, type Quake } from "../data/sky";
import { citiesAt } from "../data/taiwan";
import { air, aqiLabel, forecast, rainOutlook, weatherLabel, type Air, type Forecast } from "../data/weather";
import { ago } from "../lib/time";
import { distance, type Point } from "../lib/util";
import type { GlobeMap } from "../map/globe";
import { $ } from "./dom";

export interface NowState {
  basis: Point;
  mine: boolean;
  forecast: Forecast | null;
  air: Air | null;
  warnings: Warning[];
  quake: Quake | null;
}

export class NowBar {
  private basis: Point | null = null;
  private fetchedAt = 0;
  private state: NowState | null = null;
  private alerts: Warning[] = [];
  private alertsAt = 0;
  private quakes: Quake[] = [];
  private quakesAt = 0;
  private timer = 0;

  constructor(
    private map: GlobeMap,
    private me: () => Point | null,
    onTap: (s: NowState | null) => void,
  ) {
    $("now").addEventListener("click", () => onTap(this.state));
    map.on("moveend", () => this.schedule());
    onKeysChange(() => {
      this.alertsAt = 0;
      this.schedule(0);
    });
    setInterval(() => document.visibilityState === "visible" && this.schedule(0), 10 * 60000);
  }

  schedule(delay = 1500): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.update(), delay);
  }

  private pickBasis(): { p: Point; mine: boolean } | null {
    const me = this.me();
    if (me) return { p: me, mine: true };
    if (this.map.getZoom() < 6) return null;
    const c = this.map.getCenter();
    return { p: { lat: c.lat, lng: c.lng }, mine: false };
  }

  private async update(): Promise<void> {
    const pick = this.pickBasis();
    if (!pick) {
      this.render("拉近地圖或按 ◎ 定位，看此刻天氣", "");
      return;
    }
    const moved = !this.basis || distance(this.basis, pick.p) > 3000;
    const stale = Date.now() - this.fetchedAt > 10 * 60000;
    if (!moved && !stale && this.state) {
      this.state.mine = pick.mine;
      return;
    }
    this.basis = pick.p;
    this.fetchedAt = Date.now();
    const [f, a] = await Promise.allSettled([forecast(pick.p), air(pick.p), this.refreshSide()]);
    const city = citiesAt(pick.p)[0]?.name;
    const local = city ? this.alerts.filter((w) => w.area === city) : [];
    const quake = this.quakes
      .filter((q) => q.time !== null && Date.now() - q.time < 6 * 3600000 && distance(q, pick.p) < 300000 && (q.magnitude ?? 0) >= 4)
      .sort((x, y) => (y.time ?? 0) - (x.time ?? 0))[0] ?? null;
    this.state = {
      basis: pick.p,
      mine: pick.mine,
      forecast: f.status === "fulfilled" ? f.value : null,
      air: a.status === "fulfilled" ? a.value : null,
      warnings: local,
      quake,
    };
    const s = this.state;
    const parts: string[] = [];
    if (s.forecast) {
      const w = weatherLabel(s.forecast.code, s.forecast.isDay);
      parts.push(`${w.icon} ${s.forecast.temp === null ? "—" : Math.round(s.forecast.temp) + "°"} ${w.text}`);
      parts.push(rainOutlook(s.forecast).text);
    } else parts.push("天氣暫時無法取得");
    if (s.air?.aqi !== null && s.air?.aqi !== undefined) parts.push(`AQI ${Math.round(s.air.aqi)} ${aqiLabel(s.air.aqi).text}`);
    if (local.length) parts.unshift(`⚠ ${[...new Set(local.map((w) => w.phenomena + w.significance))].join("、")}`);
    if (quake) parts.unshift(`地震 M${quake.magnitude?.toFixed(1)} ${ago(quake.time)}`);
    const tone = quake || local.length ? "alert" : s.forecast && rainOutlook(s.forecast).level === "rain" ? "warn" : "";
    this.render(`${pick.mine ? "我這裡" : "地圖中心"} · ${parts.join(" · ")}`, tone);
  }

  /** Warnings (own CWA key) and nearby quakes refresh less often than weather. */
  private async refreshSide(): Promise<void> {
    const now = Date.now();
    const jobs: Promise<unknown>[] = [];
    if (hasCwa() && now - this.alertsAt > 15 * 60000)
      jobs.push(
        warnings().then((w) => {
          this.alerts = w;
          this.alertsAt = now;
        }),
      );
    if (!hasCwa()) this.alerts = [];
    if (now - this.quakesAt > 5 * 60000)
      jobs.push(
        usgsQuakes().then((q) => {
          this.quakes = q;
          this.quakesAt = now;
        }),
      );
    await Promise.allSettled(jobs);
  }

  private render(text: string, tone: string): void {
    $("nowText").textContent = text;
    const el = $("now");
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
  }
}
