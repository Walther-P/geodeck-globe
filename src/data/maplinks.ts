// Turning a place shared from Google Maps / Apple Maps (a link, or the text a
// share sheet produces) into a point on our map.

import { getJson } from "../lib/net";
import { validPoint } from "../lib/util";

export interface LinkPlace {
  lat?: number;
  lng?: number;
  title?: string;
  /** Text to search for when the link carries a name but no coordinates. */
  query?: string;
}

const MAP_HOSTS = /(^|\.)google\.[a-z.]+$|^maps\.app\.goo\.gl$|^goo\.gl$|^maps\.apple\.com$|^maps\.apple$/;

export function extractUrl(text: string): string | null {
  const geo = text.match(/geo:-?\d+(\.\d+)?,-?\d+(\.\d+)?[^\s]*/i);
  if (geo) return geo[0];
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[)\]，。、]+$/, "") : null;
}

/** Google's share links are short redirects that need the server to follow them. */
export function isShortLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "maps.app.goo.gl" || (u.hostname === "goo.gl" && u.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

function coords(lat: string | number, lng: string | number): { lat: number; lng: number } | null {
  const p = { lat: Number(lat), lng: Number(lng) };
  return validPoint(p) && !(p.lat === 0 && p.lng === 0) ? p : null;
}

const LATLNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function parseMapUrl(raw: string): LinkPlace | null {
  if (/^geo:/i.test(raw)) {
    const m = raw.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
    const q = new URLSearchParams(raw.split("?")[1] ?? "").get("q") ?? undefined;
    const p = m && coords(m[1], m[2]);
    return p ? { ...p, title: q?.replace(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?\s*/, "").replace(/^\((.*)\)$/, "$1") || undefined } : null;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname === "consent.google.com") {
    const next = u.searchParams.get("continue");
    return next ? parseMapUrl(next) : null;
  }
  if (!MAP_HOSTS.test(u.hostname)) return null;
  const text = decodeURIComponent(u.href.replace(/\+/g, " "));
  const out: LinkPlace = {};

  // The pin itself: Google encodes it as !3d<lat>!4d<lng> (the last pair is the place).
  const pins = [...text.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  const pin = pins.length ? coords(pins[pins.length - 1][1], pins[pins.length - 1][2]) : null;
  if (pin) Object.assign(out, pin);

  const place = u.pathname.match(/\/maps\/place\/([^/]+)/);
  if (place) out.title = decodeURIComponent(place[1].replace(/\+/g, " "));

  for (const key of ["q", "query", "destination", "daddr", "ll", "sll", "center", "coordinate", "address", "name"]) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    const m = v.match(LATLNG);
    if (m && out.lat === undefined) {
      const p = coords(m[1], m[2]);
      if (p) Object.assign(out, p);
    } else if (!m && ["q", "query", "destination", "daddr", "address", "name"].includes(key)) {
      out.query ??= v.trim();
    }
  }

  // Viewport centre (@lat,lng,zoom) only when nothing better was found.
  if (out.lat === undefined) {
    const at = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
    const p = at && coords(at[1], at[2]);
    if (p) Object.assign(out, p);
  }
  out.title ??= out.query?.split(/[,，]/)[0];
  return out.lat !== undefined || out.query || isShortLink(raw) ? out : null;
}

interface Resolved {
  url?: string;
  lat?: number;
  lng?: number;
  title?: string;
  error?: string;
}

/**
 * Everything we can learn from shared text: coordinates when the link has
 * them (following short links through our Worker), else a name to search.
 */
export async function resolveSharedPlace(text: string, signal?: AbortSignal): Promise<LinkPlace | null> {
  const url = extractUrl(text);
  if (!url) return null;
  let place = parseMapUrl(url);
  if (!place) return null;
  if (place.lat === undefined) {
    try {
      const r = await getJson<Resolved>(`./api/resolve?u=${encodeURIComponent(url)}`, { signal, timeout: 15000 });
      const followed = r.url ? parseMapUrl(r.url) : null;
      place = {
        ...place,
        ...(followed ?? {}),
        ...(r.lat !== undefined && r.lng !== undefined && (followed?.lat === undefined) ? { lat: r.lat, lng: r.lng } : {}),
        title: r.title || followed?.title || place.title,
      };
    } catch {
      /* fall back to whatever the link text said */
    }
  }
  // Share sheets often put the name on the first line above the link.
  const firstLine = text.split(/\n/)[0].trim();
  if (!place.title && firstLine && !firstLine.includes("http")) place.title = firstLine;
  if (!place.query && place.lat === undefined && place.title) place.query = place.title;
  return place;
}
