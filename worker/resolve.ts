// Following Google Maps share links (maps.app.goo.gl/…) to the place they
// point at. Browsers can't follow these cross-origin redirects themselves.

const START = /^(maps\.app\.goo\.gl|goo\.gl)$/;
const GOOGLE = /(^|\.)google\.(com|com\.[a-z]{2}|[a-z]{2}|co\.[a-z]{2})$/;

export function resolvableStart(raw: string | null): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.hostname === "goo.gl" && !u.pathname.startsWith("/maps")) return null;
  if (START.test(u.hostname)) return u;
  if (GOOGLE.test(u.hostname) && (u.pathname.startsWith("/maps") || u.hostname.startsWith("maps."))) return u;
  return null;
}

export function allowedHop(u: URL): boolean {
  return u.protocol === "https:" && (START.test(u.hostname) || GOOGLE.test(u.hostname));
}

/** A URL that already pins the place needs no page fetch. */
export function hasCoordinates(url: string): boolean {
  return /!3d-?\d+(\.\d+)?!4d-?\d+/.test(url) || /[?&](q|query|ll)=-?\d+(\.\d+)?(,|%2C)-?\d+/.test(url);
}

/**
 * Google Maps pages carry the place's position in the og:image static map
 * (center=lat,lng) and in APP_INITIALIZATION_STATE ([[[alt,lng,lat]…).
 */
export function coordinatesFromHtml(html: string): { lat: number; lng: number; title?: string } | null {
  let lat: number | null = null;
  let lng: number | null = null;
  const center = html.match(/staticmap\?center=(-?\d+(?:\.\d+)?)(?:%2C|,)(-?\d+(?:\.\d+)?)/);
  if (center) {
    lat = Number(center[1]);
    lng = Number(center[2]);
  } else {
    const state = html.match(/APP_INITIALIZATION_STATE=\[\[\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/);
    if (state) {
      lng = Number(state[2]);
      lat = Number(state[3]);
    }
  }
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const og = html.match(/<meta[^>]+(?:property="og:title"|itemprop="name")[^>]+content="([^"]+)"/) ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property="og:title"|itemprop="name")/);
  const title = og?.[1]
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .split(" · ")[0]
    .trim();
  return { lat, lng, ...(title && title !== "Google Maps" ? { title } : {}) };
}
