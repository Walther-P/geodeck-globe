// Which upstream requests the relay may forward. The relay exists only for
// public feeds that do not send CORS headers to browsers. It never stores keys:
// keyed requests (TDX, CWA) carry the visitor's own key and are never cached,
// so one visitor's key can never answer another visitor's request.

export interface RelayRule {
  id: string;
  host: string;
  path: RegExp;
  method: "GET" | "POST";
  /** Seconds the edge may share a response between visitors; 0 = never. */
  ttl: number;
  /** Request carries the visitor's own key; never cached or shared. */
  keyed: boolean;
}

export const RELAY_RULES: RelayRule[] = [
  {
    id: "adsb",
    host: "api.adsb.lol",
    path: /^\/v2\/point\/-?\d{1,3}(\.\d+)?\/-?\d{1,3}(\.\d+)?\/\d{1,3}$/,
    method: "GET",
    ttl: 8,
    keyed: false,
  },
  {
    id: "celestrak",
    host: "celestrak.org",
    path: /^\/NORAD\/elements\/gp\.php$/,
    method: "GET",
    // CelesTrak asks clients not to poll more than every couple of hours.
    ttl: 4 * 3600,
    keyed: false,
  },
  {
    id: "usgs",
    host: "earthquake.usgs.gov",
    path: /^\/earthquakes\/feed\/v1\.0\/summary\/[a-z0-9_.]+\.geojson$/,
    method: "GET",
    ttl: 120,
    keyed: false,
  },
  {
    id: "tdx-token",
    host: "tdx.transportdata.tw",
    path: /^\/auth\/realms\/TDXConnect\/protocol\/openid-connect\/token$/,
    method: "POST",
    ttl: 0,
    keyed: true,
  },
  {
    id: "tdx",
    host: "tdx.transportdata.tw",
    path: /^\/api\/(basic|advanced)\/[A-Za-z0-9/_.-]+$/,
    method: "GET",
    ttl: 0,
    keyed: true,
  },
  {
    id: "cwa",
    host: "opendata.cwa.gov.tw",
    path: /^\/api\/v1\/rest\/datastore\/[A-Z0-9-]+$/,
    method: "GET",
    ttl: 0,
    keyed: true,
  },
];

export const MAX_RELAY_BYTES = 12 * 1024 * 1024;

export function matchRelayRule(raw: string | null, method: string): { url: URL; rule: RelayRule } | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const rule = RELAY_RULES.find((r) => r.host === url.hostname && r.method === method && r.path.test(url.pathname));
  return rule ? { url, rule } : null;
}

/** Browsers mark same-origin fetches; anything else is someone using us as a free proxy. */
export function isSameOriginRequest(headers: Headers, selfOrigin: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = headers.get("origin");
  if (origin) return origin === selfOrigin;
  const referer = headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === selfOrigin;
    } catch {
      return false;
    }
  }
  return false;
}
