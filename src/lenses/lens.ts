import type { MapGeoJSONFeature } from "maplibre-gl";
import type { GlobeMap } from "../map/globe";
import type { Place } from "../data/places";
import type { Point } from "../lib/util";
import type { Sheet } from "../ui/dom";

export type LensId = "weather" | "traffic" | "parking" | "sky";
export type Tone = "ok" | "warn" | "bad";

export interface AppContext {
  map: GlobeMap;
  sheet: Sheet;
  toast(text: string): void;
  /** Update the strip status line for a lens (shown while it has focus). */
  status(lens: LensId, text: string, tone?: Tone): void;
  /** Re-render the strip (chips/controls) for a lens. */
  refreshStrip(lens: LensId): void;
  /** Place card for any point; intent pre-selects a navigation mode. */
  openPlace(p: Place, intent?: "navigate" | "walk"): void;
  onFeatureTap(layers: string[], handler: (f: MapGeoJSONFeature) => void): void;
  openSettings(section?: string): void;
  /** Last known device position, if the user has located themselves. */
  me(): Point | null;
}

export interface Chip {
  id: string;
  label: string;
  on: boolean;
  /** Feature needs the visitor's own key. */
  needs?: "tdx" | "cwa";
}

export interface Lens {
  id: LensId;
  title: string;
  chips(): Chip[];
  toggleChip(id: string): void;
  activate(): void;
  deactivate(): void;
  /** Optional extra controls under the chips (e.g. radar timeline). */
  renderExtra?(el: HTMLElement): void;
}

/** Runs `fn` now and every `ms` while the page is visible. */
export function every(ms: number, fn: () => void): () => void {
  let timer = 0;
  const tick = () => {
    if (document.visibilityState === "visible") fn();
  };
  timer = window.setInterval(tick, ms);
  const onVisible = () => {
    if (document.visibilityState === "visible") fn();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function viewBounds(map: GlobeMap) {
  const b = map.getBounds();
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
}
