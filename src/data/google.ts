// Google place search, so "某某餐廳" finds the same places Google Maps does,
// with the site owner's key (GOOGLE_MAPS_KEY at build) or a visitor's own.
// Uses the Maps JavaScript API's Places library (made for browsers); no map
// is drawn, so only the search itself is billed to the key owner.

import { FeedError } from "../lib/net";
import type { Point } from "../lib/util";
import { keys } from "./keys";
import type { Place } from "./places";

interface LatLng {
  lat(): number;
  lng(): number;
}

interface GooglePlace {
  id?: string;
  displayName?: string | null;
  formattedAddress?: string | null;
  location?: LatLng | null;
}

interface PlacesLibrary {
  Place: { searchByText(request: Record<string, unknown>): Promise<{ places: GooglePlace[] }> };
}

interface GoogleMaps {
  maps: { importLibrary(name: "places"): Promise<PlacesLibrary> };
}

/** The site owner's key, baked in at build time; a visitor's own key wins. */
const SITE_KEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY ?? "").trim();

export const siteGoogleKey = () => !!SITE_KEY;
/** The visitor's own key wins over the site's. */
export const googleKey = () => keys().google || SITE_KEY;
export const googleAvailable = () => !!googleKey();

let loading: { key: string; ready: Promise<GoogleMaps> } | null = null;
let authFailed = false;

function load(key: string): Promise<GoogleMaps> {
  if (loading?.key === key) return loading.ready;
  authFailed = false;
  const ready = new Promise<GoogleMaps>((resolve, reject) => {
    const w = window as unknown as Record<string, unknown>;
    const callback = `gdgGoogleReady${Date.now()}`;
    const timer = setTimeout(() => reject(new FeedError("Google 搜尋載入逾時")), 15000);
    w[callback] = () => {
      clearTimeout(timer);
      resolve(w.google as GoogleMaps);
    };
    // Google calls this when the key is wrong or not allowed on this site.
    w.gm_authFailure = () => {
      authFailed = true;
    };
    const q = new URLSearchParams({ key, v: "weekly", loading: "async", libraries: "places", language: "zh-TW", region: "TW", callback });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${q}`;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new FeedError("Google 搜尋無法載入"));
    };
    document.head.append(script);
  });
  loading = { key, ready };
  ready.catch(() => (loading = null));
  return ready;
}

export async function googleSearch(text: string, near: Point | null): Promise<Place[]> {
  const key = googleKey();
  if (!key) return [];
  const google = await load(key);
  const { Place: GPlace } = await google.maps.importLibrary("places");
  const request: Record<string, unknown> = {
    textQuery: text,
    fields: ["id", "displayName", "formattedAddress", "location"],
    language: "zh-TW",
    region: "tw",
    maxResultCount: 8,
  };
  if (near) request.locationBias = { lat: near.lat, lng: near.lng };
  let places: GooglePlace[];
  try {
    ({ places } = await GPlace.searchByText(request));
  } catch (e) {
    throw new FeedError(authFailed ? "Google 金鑰無效，或沒有允許這個網站使用" : `Google 搜尋失敗：${(e as Error).message}`);
  }
  if (authFailed) throw new FeedError("Google 金鑰無效，或沒有允許這個網站使用");
  return places.flatMap((p) => {
    const loc = p.location;
    if (!loc) return [];
    return [{ lat: loc.lat(), lng: loc.lng(), title: p.displayName ?? "地點", subtitle: p.formattedAddress ?? "", googleId: p.id, source: "Google" }];
  });
}

export async function testGoogle(): Promise<string> {
  const r = await googleSearch("台北101", { lat: 25.03, lng: 121.56 });
  if (!r.length) throw new FeedError("Google 有回應，但沒有找到「台北101」");
  return `Google 搜尋可用（找到「${r[0].title}」）`;
}
