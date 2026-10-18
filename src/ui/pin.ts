// Tapping the map drops a pin first, so it is clear which spot was picked;
// the place card opens from the pin's callout. The pin can be dragged to
// fine-tune the spot.

import { Marker } from "maplibre-gl";
import type { Place } from "../data/places";
import { escapeHtml as esc, formatCoord } from "../lib/util";
import type { GlobeMap } from "../map/globe";
import { reverseName } from "./place";

export class DropPin {
  place: Place | null = null;
  private marker: Marker | null = null;
  private el: HTMLElement | null = null;
  private seq = 0;

  constructor(
    private map: GlobeMap,
    private open: (p: Place) => void,
  ) {}

  /** Put the pin here with its callout; `collapsed` hides the callout (a card is already open). */
  drop(p: Place, opts: { collapsed?: boolean } = {}): void {
    const moved = !this.place || this.place.lat !== p.lat || this.place.lng !== p.lng;
    this.place = { ...p, title: p.title || (moved ? "" : (this.place?.title ?? "")) };
    const el = this.el ?? this.build();
    el.classList.toggle("collapsed", !!opts.collapsed);
    if (!this.marker) {
      this.marker = new Marker({ element: el, anchor: "bottom", draggable: true }).setLngLat([p.lng, p.lat]).addTo(this.map);
      this.marker.on("dragend", () => {
        const at = this.marker!.getLngLat();
        this.place = { lat: at.lat, lng: at.lng, title: "" };
        el.classList.remove("collapsed");
        this.render();
        void this.lookup();
      });
    } else this.marker.setLngLat([p.lng, p.lat]);
    if (moved) {
      // Replay the drop animation.
      el.classList.remove("dropped");
      void el.offsetWidth;
      el.classList.add("dropped");
    }
    this.render();
    if (!this.place.title) void this.lookup();
  }

  clear(): void {
    this.marker?.remove();
    this.marker = null;
    this.el = null;
    this.place = null;
  }

  private build(): HTMLElement {
    const el = document.createElement("div");
    el.className = "drop-pin";
    el.innerHTML = `<div class="pin-card"><button type="button" class="pin-callout"></button><button type="button" class="pin-x" aria-label="移除標記">×</button></div>
      <svg class="pin-mark" width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39S2 23.5 2 14.5a13 13 0 0 1 26 0C28 23.5 15 39 15 39Z" fill="#f87171" stroke="#04080d" stroke-width="2"/><circle cx="15" cy="14.5" r="5.2" fill="#04080d"/><path d="M15 6.5v4M15 18.5v4M7 14.5h4M19 14.5h4" stroke="#04080d" stroke-width="1.6"/></svg>
      <span class="pin-dot" aria-hidden="true"></span>`;
    const go = (e: Event) => {
      e.stopPropagation();
      if (!this.place) return;
      el.classList.add("collapsed");
      // Keep the pin above the card that slides up from the bottom.
      const pt = this.map.project([this.place.lng, this.place.lat]);
      if (pt.y > this.map.getContainer().clientHeight * 0.4) this.map.easeTo({ center: [this.place.lng, this.place.lat], offset: [0, -this.map.getContainer().clientHeight * 0.22], duration: 500 });
      this.open(this.place);
    };
    el.querySelector(".pin-callout")!.addEventListener("click", go);
    el.querySelector(".pin-mark")!.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el.classList.contains("collapsed")) el.classList.remove("collapsed");
      else go(e);
    });
    el.querySelector(".pin-x")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clear();
    });
    this.el = el;
    return el;
  }

  private render(): void {
    const p = this.place;
    const callout = this.el?.querySelector(".pin-callout");
    if (!p || !callout) return;
    callout.innerHTML = `<b>${esc(p.title || "這裡")}</b><small>${formatCoord(p, 5)}</small><span class="pin-go">看天氣與資訊 ›</span>`;
  }

  private async lookup(): Promise<void> {
    const mine = ++this.seq;
    const p = this.place;
    if (!p) return;
    const name = await reverseName(p);
    if (mine !== this.seq || !this.place || !name) return;
    this.place.title = name;
    this.render();
  }
}
