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
  /**
   * Seconds the last good answer may stand in when the upstream refuses or
   * fails (shown as `x-relay-cache: STALE`). Never for keyed rules.
   */
  staleTtl?: number;
}

export const RELAY_RULES: RelayRule[] = [
  {
    id: "adsb",
    host: "api.adsb.lol",
    path: /^\/v2\/point\/-?\d{1,3}(\.\d+)?\/-?\d{1,3}(\.\d+)?\/\d{1,3}$/,
    method: "GET",
    ttl: 10,
    keyed: false,
    staleTtl: 600,
  },
  {
    id: "airplanes-live",
    host: "api.airplanes.live",
    path: /^\/v2\/point\/-?\d{1,3}(\.\d+)?\/-?\d{1,3}(\.\d+)?\/\d{1,3}$/,
    method: "GET",
    ttl: 10,
    keyed: false,
    staleTtl: 600,
  },
  {
    id: "adsb-fi",
    host: "opendata.adsb.fi",
    path: /^\/api\/v2\/lat\/-?\d{1,3}(\.\d+)?\/lon\/-?\d{1,3}(\.\d+)?\/dist\/\d{1,3}$/,
    method: "GET",
    ttl: 10,
    keyed: false,
    staleTtl: 600,
  },
  {
    id: "adsb-one",
    host: "api.adsb.one",
    path: /^\/v2\/point\/-?\d{1,3}(\.\d+)?\/-?\d{1,3}(\.\d+)?\/\d{1,3}$/,
    method: "GET",
    ttl: 10,
    keyed: false,
    staleTtl: 600,
  },
  {
    id: "opensky",
    host: "opensky-network.org",
    path: /^\/api\/states\/all$/,
    method: "GET",
    ttl: 10,
    keyed: false,
    staleTtl: 600,
  },
  {
    id: "celestrak",
    host: "celestrak.org",
    path: /^\/NORAD\/elements\/gp\.php$/,
    method: "GET",
    // CelesTrak asks clients not to poll more than every couple of hours.
    ttl: 4 * 3600,
    keyed: false,
    staleTtl: 3 * 86400,
  },
  {
    id: "usgs",
    host: "earthquake.usgs.gov",
    path: /^\/earthquakes\/feed\/v1\.0\/summary\/[a-z0-9_.]+\.geojson$/,
    method: "GET",
    ttl: 120,
    keyed: false,
    staleTtl: 3600,
  },
  {
    // Upcoming launches; the free tier allows 15 calls an hour per IP.
    id: "launches",
    host: "ll.thespacedevs.com",
    path: /^\/2\.3\.0\/launches\/upcoming\/$/,
    method: "GET",
    ttl: 3600,
    keyed: false,
    staleTtl: 86400,
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
