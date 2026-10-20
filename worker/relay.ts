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
  /**
   * The site's own key for this upstream, kept as a Worker secret and added
   * here, so it never reaches the browser. Without the secret the rule
   * answers 501 and the page leaves that source out.
   */
  siteKey?: { env: SiteKeyName; header?: string; param?: string };
}

/** Worker secrets the owner may set (GitHub secrets of the same name; see deploy.yml). */
export const SITE_KEYS = ["WINDY_WEBCAMS_KEY", "ON511_KEY", "AB511_KEY", "NY511_KEY"] as const;
export type SiteKeyName = (typeof SITE_KEYS)[number];

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
  // Official road-camera lists abroad (src/data/worldcams.ts) whose hosts do
  // not answer browsers directly. Lists change rarely; images load directly.
  ...(
    [
      ["cam-nz", "trafficnz.info", /^\/service\/traffic\/rest\/4\/cameras\/all$/],
      ["cam-qld", "api.qldtraffic.qld.gov.au", /^\/v1\/webcams$/],
      ["cam-nsw", "www.livetraffic.com", /^\/datajson\/all-feeds-web\.json$/],
      ["cam-es", "nap.dgt.es", /^\/datex2\/v3\/dgt\/DevicePublication\/camaras_datex2_v36\.xml$/],
      ["cam-is", "gagnaveita.vegagerdin.is", /^\/api\/vefmyndavelar2014_1$/],
      ["cam-nyc", "webcams.nyctmc.org", /^\/api\/cameras$/],
      ["cam-md", "chartexp1.sha.maryland.gov", /^\/CHARTExportClientService\/getCameraMapDataJSON\.do$/],
      ["cam-bc", "www.drivebc.ca", /^\/api\/webcams\/$/],
      ["cam-toronto", "ckan0.cf.opendata.inter.prod-toronto.ca", /^\/dataset\/[0-9a-f-]+\/resource\/[0-9a-f-]+\/download\/traffic-camera-list-4326\.geojson$/],
    ] as const
  ).map(([id, host, path]): RelayRule => ({ id, host, path, method: "GET", ttl: 3600, keyed: false, staleTtl: 7 * 86400 })),
  // Camera feeds that need a key: the site's own, added by the Worker (siteKey).
  {
    id: "windy",
    host: "api.windy.com",
    path: /^\/webcams\/api\/v3\/webcams$/,
    method: "GET",
    // Image links in the answer expire, so it is not kept long.
    ttl: 300,
    keyed: false,
    siteKey: { env: "WINDY_WEBCAMS_KEY", header: "x-windy-api-key" },
  },
  ...(
    [
      ["cam-on511", "511on.ca", /^\/api\/v2\/get\/cameras$/, "ON511_KEY"],
      ["cam-ab511", "511.alberta.ca", /^\/api\/v2\/get\/cameras$/, "AB511_KEY"],
      ["cam-ny511", "511ny.org", /^\/api\/getcameras$/, "NY511_KEY"],
    ] as const
  ).map(([id, host, path, env]): RelayRule => ({ id, host, path, method: "GET", ttl: 3600, keyed: false, staleTtl: 7 * 86400, siteKey: { env, param: "key" } })),
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

/** The upstream request with the site's key added; null when that key is not set. */
export function withSiteKey(url: URL, rule: RelayRule, keys: Partial<Record<SiteKeyName, string>>): { url: URL; headers: Record<string, string> } | null {
  if (!rule.siteKey) return { url, headers: {} };
  const key = keys[rule.siteKey.env]?.trim();
  if (!key) return null;
  const out = new URL(url);
  const headers: Record<string, string> = {};
  if (rule.siteKey.param) out.searchParams.set(rule.siteKey.param, key);
  if (rule.siteKey.header) headers[rule.siteKey.header] = key;
  return { url: out, headers };
}

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
