// 電台：radio stations around the world as dots; tap one to listen.

import { countPlay, stationsNear, topStations, type Station } from "../data/radio";
import { distance, escapeHtml as esc, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, points, setData } from "../map/globe";
import { viewBounds, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = ["rd-cluster", "rd-cluster-count", "rd-dot", "rd-playing", "rd-label"];

export class RadioLens implements Lens {
  id = "radio" as const;
  title = "電台";
  private on = { near: true, global: true };
  private top: Station[] = [];
  private near: Station[] = [];
  private nearKey = "";
  private shown: Station[] = [];
  private playing: Station | null = null;
  private paused = false;
  private audio = new Audio();
  private active = false;
  private note = "";
  private moveTimer = 0;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => void this.loadNear(), 900);
  };

  constructor(private ctx: AppContext) {
    this.audio.preload = "none";
    this.audio.addEventListener("error", () => {
      if (!this.playing) return;
      ctx.toast(`「${this.playing.name}」目前無法播放（可能停播或格式不支援），換一台試試`, 5000);
      this.stop();
    });
    this.audio.addEventListener("playing", () => {
      this.paused = false;
      this.report();
    });
    ctx.onFeatureTap(["rd-dot", "rd-playing"], (f) => {
      const s = this.shown.find((x) => x.id === f.properties.id);
      if (s) this.play(s);
    });
    ctx.onFeatureTap(["rd-cluster"], (f) => {
      const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      ctx.map.easeTo({ center: c, zoom: ctx.map.getZoom() + 2 });
    });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("pause", () => this.togglePause());
      navigator.mediaSession.setActionHandler("play", () => this.togglePause());
      navigator.mediaSession.setActionHandler("stop", () => this.stop());
    }
  }

  chips(): Chip[] {
    return [
      { id: "near", label: "附近電台", on: this.on.near },
      { id: "global", label: "全球熱門", on: this.on.global },
    ];
  }

  toggleChip(id: string): void {
    const key = id as keyof typeof this.on;
    this.on[key] = !this.on[key];
    if (this.active) this.draw();
  }

  renderExtra(el: HTMLElement): void {
    const s = this.playing;
    el.innerHTML = `${
      s
        ? `<div class="player"><button class="play" id="rdToggle" aria-label="${this.paused ? "播放" : "暫停"}">${this.paused ? "▶" : "❚❚"}</button>
          <div class="player-text"><b>${esc(s.name)}</b><small>${esc([s.state, s.country].filter(Boolean).join("，"))}${s.bitrate ? ` · ${s.bitrate} kbps` : ""}</small></div>
          <button class="icon-btn" id="rdInfo" aria-label="電台資訊">ⓘ</button><button class="icon-btn" id="rdStop" aria-label="停止">■</button></div>`
        : ""
    }<div class="extra-actions"><button class="chip" id="rdRandom">隨機一台</button><button class="chip" id="rdList">清單</button><span class="micro">點地圖上的紫點就能收聽</span></div>`;
    el.querySelector("#rdToggle")?.addEventListener("click", () => this.togglePause());
    el.querySelector("#rdStop")?.addEventListener("click", () => this.stop());
    el.querySelector("#rdInfo")?.addEventListener("click", () => this.playing && this.info(this.playing));
    el.querySelector("#rdRandom")!.addEventListener("click", () => void this.random());
    el.querySelector("#rdList")!.addEventListener("click", () => this.list());
  }

  activate(): void {
    this.active = true;
    const map = this.ctx.map;
    setData(map, "rd", EMPTY, { radius: 34, maxZoom: 6 });
    setData(map, "rd-now", EMPTY);
    addLayers(map, [
      {
        id: "rd-cluster",
        type: "circle",
        source: "rd",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "rgba(192, 132, 252, 0.16)",
          "circle-stroke-color": "#c084fc",
          "circle-stroke-width": 1,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 10, 50, 16, 300, 24],
        },
      },
      {
        id: "rd-cluster-count",
        type: "symbol",
        source: "rd",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
        paint: { "text-color": "#e9d5ff" },
      },
      {
        id: "rd-dot",
        type: "circle",
        source: "rd",
        filter: ["!", ["has", "point_count"]],
        paint: { "circle-radius": 5, "circle-color": "#c084fc", "circle-stroke-color": "#1e0b2e", "circle-stroke-width": 1.5 },
      },
      {
        id: "rd-label",
        type: "symbol",
        source: "rd",
        minzoom: 8,
        filter: ["!", ["has", "point_count"]],
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-offset": [0, 1.3], "text-optional": true },
        paint: { "text-color": "#e9d5ff", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
      },
      {
        id: "rd-playing",
        type: "circle",
        source: "rd-now",
        paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#f0abfc", "circle-stroke-width": 2.2 },
      },
    ]);
    map.on("moveend", this.onMove);
    void this.loadTop();
    void this.loadNear();
  }

  deactivate(): void {
    this.active = false;
    this.ctx.map.off("moveend", this.onMove);
    this.stop();
    hideLayers(this.ctx.map, LAYERS);
  }

  private async loadTop(): Promise<void> {
    if (this.top.length) return this.draw();
    try {
      this.top = await topStations();
      this.note = "";
    } catch (e) {
      this.note = `電台資料庫暫時無法連線：${(e as Error).message}`;
    }
    this.draw();
  }

  private async loadNear(): Promise<void> {
    if (!this.active || !this.on.near) return;
    const map = this.ctx.map;
    if (map.getZoom() < 4) return;
    const c = map.getCenter();
    const b = viewBounds(map);
    const km = distance({ lat: c.lat, lng: c.lng }, { lat: b.north, lng: b.east }) / 1000;
    const key = `${c.lat.toFixed(1)},${c.lng.toFixed(1)},${Math.round(km / 50)}`;
    if (key === this.nearKey) return;
    this.nearKey = key;
    try {
      this.near = await stationsNear({ lat: c.lat, lng: c.lng }, km * 1.2);
    } catch {
      /* the global list still shows */
    }
    this.draw();
  }

  private draw(): void {
    if (!this.active) return;
    const byId = new Map<string, Station>();
    if (this.on.global) for (const s of this.top) byId.set(s.id, s);
    if (this.on.near) for (const s of this.near) byId.set(s.id, s);
    this.shown = [...byId.values()];
    setData(this.ctx.map, "rd", points(this.shown, (s) => ({ id: s.id, name: s.name })));
    this.report();
  }

  private report(): void {
    const parts = [this.note || `電台 ${this.shown.length.toLocaleString()} 台（Radio Browser 社群資料庫）`];
    if (this.playing) parts.unshift(`${this.paused ? "已暫停" : "播放中"}：${this.playing.name}`);
    this.ctx.status("radio", parts.join(" · "), this.note ? "warn" : undefined);
    this.ctx.refreshStrip("radio");
  }

  private play(s: Station): void {
    this.playing = s;
    this.paused = false;
    this.audio.src = s.url;
    void this.audio.play().catch(() => {
      /* the error event explains */
    });
    countPlay(s.id);
    setData(this.ctx.map, "rd-now", points([s], (x) => ({ id: x.id })));
    if ("mediaSession" in navigator)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.name,
        artist: [s.state, s.country].filter(Boolean).join("，"),
        album: "百眼 · 全球電台",
        artwork: s.favicon ? [{ src: s.favicon }] : [],
      });
    this.ctx.toast(`連線中：${s.name}`, 2000);
    this.report();
  }

  private togglePause(): void {
    if (!this.playing) return;
    if (this.paused) {
      void this.audio.play().catch(() => {});
      this.paused = false;
    } else {
      this.audio.pause();
      this.paused = true;
    }
    this.report();
  }

  private stop(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.playing = null;
    this.paused = false;
    if (this.active) setData(this.ctx.map, "rd-now", EMPTY);
    if (this.active) this.report();
  }

  /** Somewhere in the world, at random: fly there and start listening. */
  private async random(): Promise<void> {
    if (!this.top.length) await this.loadTop();
    const pool = this.top.filter((s) => s.id !== this.playing?.id);
    const s = pool[Math.floor(Math.random() * pool.length)];
    if (!s) return;
    this.ctx.map.flyTo({ center: [s.lng, s.lat], zoom: 7, duration: 2600, essential: true });
    this.play(s);
  }

  private list(): void {
    const c = this.ctx.map.getCenter();
    const here = { lat: c.lat, lng: c.lng };
    const rows = [...this.shown].sort((a, z) => distance(here, a) - distance(here, z)).slice(0, 40);
    const body = this.ctx.sheet.open(
      "radio-list",
      "RADIO",
      "地圖中心附近的電台",
      rows.length
        ? `<ul class="list">${rows
            .map(
              (s, i) => `<li><div><b>${esc(s.name)}</b><small>${esc([s.state, s.country].filter(Boolean).join("，"))}${s.tags.length ? ` · ${esc(s.tags.slice(0, 3).join("、"))}` : ""}</small></div><button class="btn" data-play="${i}">收聽</button></li>`,
            )
            .join("")}</ul><p class="micro">資料：Radio Browser（社群維護）。只列出這個網頁能播放的 https 串流；電台可能隨時停播。</p>`
        : `<p class="muted">這附近沒有收錄的電台。按「隨機一台」到世界各地聽聽看。</p>`,
    );
    body.querySelectorAll<HTMLElement>("[data-play]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.sheet.close();
        this.play(rows[Number(b.dataset.play)]);
      }),
    );
  }

  private info(s: Station): void {
    const home = safeUrl(s.homepage);
    this.ctx.sheet.open(
      "radio",
      "RADIO",
      s.name,
      `<p>${esc([s.state, s.country].filter(Boolean).join("，"))}${s.language ? `<br>語言：${esc(s.language)}` : ""}</p>
      ${s.tags.length ? `<p class="muted">${esc(s.tags.join("、"))}</p>` : ""}
      <p class="micro">${esc(s.codec || "串流")}${s.bitrate ? ` ${s.bitrate} kbps` : ""} · 資料：Radio Browser 社群資料庫</p>
      ${home ? `<div class="actions"><a class="btn" href="${esc(home)}" target="_blank" rel="noopener">電台網站</a></div>` : ""}`,
    );
  }
}
