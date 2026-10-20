// Road cameras outside Taiwan: official open feeds from transport agencies,
// each loaded only when the map looks at the area it covers. Feeds that do
// not let browsers read their camera list go through the relay; the images
// themselves are plain https stills (refreshed while open), and Maryland
// publishes only HLS video, which iPhone and Safari play natively.
//
// Probed from CI with scripts/live-probe.mjs; see docs/DATA-SOURCES.md.

import { getJson, getText, type Route } from "../lib/net";
import { point, safeUrl, type Bounds } from "../lib/util";
import type { Camera } from "./tdx";

export interface CamSource {
  id: string;
  /** Operator, shown under each camera. */
  name: string;
  /** Short place name for the status line. */
  place: string;
  bbox: Bounds;
  /** Below this zoom the list is not fetched (some are megabytes). */
  minZoom: number;
  /** Works only once the owner has set the site's key for it. */
  needsKey?: boolean;
  load(): Promise<Camera[]>;
}

const box = (south: number, west: number, north: number, east: number): Bounds => ({ south, west, north, east });

function cam(src: { id: string; name: string }, id: string | number, name: string, lat: unknown, lng: unknown, extra: Partial<Camera> & { image: string | null }): Camera | null {
  const p = point(lat, lng);
  const image = safeUrl(extra.image, { httpsOnly: true });
  const video = safeUrl(extra.video, { httpsOnly: true });
  if (!p || (!image && !video)) return null;
  return { page: null, refreshS: 60, ...extra, id: `${src.id}:${id}`, name: name.trim() || "道路鏡頭", ...p, image, video, source: src.name };
}

function compact<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

/** Text of the first `<prefix:name>` element in an XML fragment, whatever the namespace prefix. */
export function xmlText(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}>([^<]*)</(?:[\\w-]+:)?${name}>`));
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : "";
}

// ---- Parsers (pure, tested against saved samples) --------------------------

const HK = { id: "hk", name: "香港運輸署" };
export function parseHongKong(xml: string): Camera[] {
  return compact(
    [...xml.matchAll(/<image>([\s\S]*?)<\/image>/g)].map(([, b]) =>
      cam(HK, xmlText(b, "key"), xmlText(b, "description").replace(/\s*\[[^\]]+\]\s*$/, ""), xmlText(b, "latitude"), xmlText(b, "longitude"), { image: xmlText(b, "url"), refreshS: 120 }),
    ),
  );
}

const SG = { id: "sg", name: "新加坡陸路交通管理局（data.gov.sg）" };
interface SgRow {
  camera_id?: string;
  image?: string;
  location?: { latitude?: number; longitude?: number };
}
export function parseSingapore(d: { items?: Array<{ cameras?: SgRow[] }> }): Camera[] {
  return compact((d?.items?.[0]?.cameras ?? []).map((c) => cam(SG, c.camera_id ?? "", `新加坡道路鏡頭 ${c.camera_id ?? ""}`, c.location?.latitude, c.location?.longitude, { image: c.image ?? null })));
}

const NZ = { id: "nz", name: "紐西蘭交通局 NZTA" };
interface NzRow {
  id?: number;
  name?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  imageUrl?: string;
  offline?: boolean;
  underMaintenance?: boolean;
}
export function parseNewZealand(d: { response?: { camera?: NzRow[] } }): Camera[] {
  return compact(
    (d?.response?.camera ?? []).map((c) =>
      c.offline || c.underMaintenance || !c.imageUrl
        ? null
        : cam(NZ, c.id ?? "", [c.name, c.description].filter(Boolean).join(" · "), c.latitude, c.longitude, { image: new URL(c.imageUrl, "https://www.trafficnz.info/").toString() }),
    ),
  );
}

const NSW = { id: "nsw", name: "新南威爾斯交通局 Live Traffic NSW" };
export function parseNsw(d: Array<{ id?: string; eventCategory?: string; geometry?: { coordinates?: number[] }; properties?: { title?: string; view?: string; href?: string } }>): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((f) =>
      f.eventCategory !== "liveCams" ? null : cam(NSW, f.id ?? "", [f.properties?.title, f.properties?.view].filter(Boolean).join(" · "), f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0], { image: f.properties?.href ?? null }),
    ),
  );
}

const FI = { id: "fi", name: "芬蘭交通管理局 Fintraffic（Digitraffic）" };
export function parseFinland(d: {
  features?: Array<{ geometry?: { coordinates?: number[] }; properties?: { id?: string; name?: string; collectionStatus?: string; presets?: Array<{ id?: string; inCollection?: boolean }> } }>;
}): Camera[] {
  return compact(
    (d?.features ?? []).map((f) => {
      const p = f.properties ?? {};
      const presets = (p.presets ?? []).filter((x) => x.id && x.inCollection !== false);
      if (p.collectionStatus !== "GATHERING" || !presets.length) return null;
      const views = presets.map((x, i) => ({ label: `方向 ${i + 1}`, image: `https://weathercam.digitraffic.fi/${x.id}.jpg` }));
      // Station names look like "kt51_Inkoo": road number, then the place.
      const name = (p.name ?? "").replace(/^(vt|kt|st|mt|yt)(\d+)_/i, (_, _k, n) => `${n} 號公路 `).replace(/_/g, " ");
      return cam(FI, p.id ?? "", name, f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0], { image: views[0].image, views: views.length > 1 ? views : undefined, refreshS: 300 });
    }),
  );
}

const TFL = { id: "tfl", name: "倫敦交通局 TfL（Powered by TfL Open Data）" };
export function parseTfl(d: Array<{ id?: string; commonName?: string; lat?: number; lon?: number; additionalProperties?: Array<{ key?: string; value?: string }> }>): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((p) => {
      const prop = (k: string) => p.additionalProperties?.find((a) => a.key === k)?.value ?? null;
      if (prop("available") === "false") return null;
      return cam(TFL, (p.id ?? "").replace(/^JamCams_/, ""), p.commonName ?? "", p.lat, p.lon, { image: prop("imageUrl"), clip: safeUrl(prop("videoUrl"), { httpsOnly: true }) });
    }),
  );
}

const DGT = { id: "dgt", name: "西班牙交通總局 DGT" };
export function parseSpain(xml: string): Camera[] {
  return compact(
    [...xml.matchAll(/<(?:[\w-]+:)?device\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?device>/g)].map(([, id, b]) => {
      if (xmlText(b, "typeOfDevice") !== "camera") return null;
      const road = xmlText(b, "roadName");
      const km = xmlText(b, "kilometerPoint");
      const where = [xmlText(b, "roadDestination") && `往 ${xmlText(b, "roadDestination")}`, xmlText(b, "province")].filter(Boolean).join("，");
      const name = `${road}${km ? ` 公里 ${km}` : ""}${where ? `（${where}）` : ""}`;
      return cam(DGT, id, name, xmlText(b, "latitude"), xmlText(b, "longitude"), { image: xmlText(b, "deviceUrl"), refreshS: 120 });
    }),
  );
}

const IS = { id: "is", name: "冰島道路管理局 Vegagerðin" };
export function parseIceland(d: Array<{ Maelist_nr?: number; Myndavel?: string; Skyring?: string; Slod?: string; Breidd?: number; Lengd?: number }>): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((c, i) => cam(IS, `${c.Maelist_nr ?? "x"}-${i}`, [c.Myndavel, c.Skyring].filter(Boolean).join(" · "), c.Breidd, c.Lengd, { image: c.Slod ?? null, refreshS: 300 })),
  );
}

const NYC = { id: "nyc", name: "紐約市交通局 NYC DOT" };
export function parseNyc(d: Array<{ id?: string; name?: string; area?: string; latitude?: number; longitude?: number; isOnline?: string | boolean; imageUrl?: string }>): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((c) =>
      String(c.isOnline) === "false" ? null : cam(NYC, c.id ?? "", [c.name, c.area].filter(Boolean).join("，"), c.latitude, c.longitude, { image: c.imageUrl ?? null, refreshS: 30 }),
    ),
  );
}

const CALTRANS = { id: "ca", name: "加州交通局 Caltrans" };
interface CaltransRow {
  cctv?: {
    index?: string;
    inService?: string;
    location?: { locationName?: string; nearbyPlace?: string; latitude?: string; longitude?: string };
    imageData?: { static?: { currentImageURL?: string } };
  };
}
export function parseCaltrans(d: { data?: CaltransRow[] }, district: number): Camera[] {
  return compact(
    (d?.data ?? []).map(({ cctv: c }) => {
      if (!c || c.inService === "false") return null;
      const name = [c.location?.locationName?.replace(/^\S+\s+--\s+/, ""), c.location?.nearbyPlace].filter(Boolean).join("，");
      return cam({ id: `ca${district}`, name: CALTRANS.name }, c.index ?? "", name, c.location?.latitude, c.location?.longitude, { image: c.imageData?.static?.currentImageURL ?? null });
    }),
  );
}

const IOWA = { id: "ia", name: "愛荷華州交通廳 Iowa DOT" };
export function parseIowa(d: { features?: Array<{ id?: number; geometry?: { coordinates?: number[] }; properties?: { Desc_?: string; ImageURL?: string } }> }): Camera[] {
  return compact(
    (d?.features ?? []).map((f, i) => cam(IOWA, f.id ?? i, f.properties?.Desc_ ?? "", f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0], { image: f.properties?.ImageURL ?? null })),
  );
}

const MD = { id: "md", name: "馬里蘭州公路局 CHART" };
export function parseMaryland(d: { data?: Array<{ id?: string; name?: string; description?: string; lat?: number; lon?: number; cctvIp?: string; opStatus?: string; publicVideoURL?: string }> }): Camera[] {
  return compact(
    (d?.data ?? []).map((c) => {
      if (c.opStatus !== "OK" || !c.id || !c.cctvIp || !/^[a-z0-9.-]+\.maryland\.gov$/i.test(c.cctvIp)) return null;
      return cam(MD, c.id, c.name || c.description || "", c.lat, c.lon, { image: null, video: `https://${c.cctvIp}/rtplive/${c.id}/playlist.m3u8`, page: safeUrl(c.publicVideoURL, { httpsOnly: true }) });
    }),
  );
}

const BC = { id: "bc", name: "卑詩省交通廳 DriveBC" };
export function parseDriveBc(
  d: Array<{ id?: number; name?: string; caption?: string; is_on?: boolean; should_appear?: boolean; marked_stale?: boolean; location?: { coordinates?: number[] }; links?: { imageDisplay?: string } }>,
): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((c) =>
      !c.is_on || c.should_appear === false || !c.links?.imageDisplay
        ? null
        : cam(BC, c.id ?? "", [c.name, c.caption].filter(Boolean).join(" · "), c.location?.coordinates?.[1], c.location?.coordinates?.[0], {
            // The listed URL carries a timestamp; the bare one is always the latest frame.
            image: new URL(c.links.imageDisplay.split("?")[0], "https://www.drivebc.ca/").toString(),
          }),
    ),
  );
}

const OTTAWA = { id: "ott", name: "渥太華市政府" };
export function parseOttawa(d: Array<{ number?: number; id?: number; description?: string; latitude?: number; longitude?: number }>): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((c) => (c.number === undefined ? null : cam(OTTAWA, c.number, c.description ?? "", c.latitude, c.longitude, { image: `https://traffic.ottawa.ca/beta/camera?id=${c.number}` }))),
  );
}

const CALGARY = { id: "yyc", name: "卡加利市政府" };
export function parseCalgary(d: Array<{ camera_url?: { url?: string }; camera_location?: string; quadrant?: string; point?: { coordinates?: number[] } }>): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((c, i) => {
      // Listed as http; the same host answers over https.
      const image = c.camera_url?.url?.replace(/^http:\/\/trafficcam\.calgary\.ca\//, "https://trafficcam.calgary.ca/") ?? null;
      return cam(CALGARY, image?.match(/loc(\d+)/)?.[1] ?? i, [c.camera_location, c.quadrant].filter(Boolean).join(" "), c.point?.coordinates?.[1], c.point?.coordinates?.[0], { image });
    }),
  );
}

const TORONTO = { id: "yyz", name: "多倫多市政府" };
export function parseToronto(d: { features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: { REC_ID?: number; IMAGEURL?: string; MAINROAD?: string; CROSSROAD?: string } }> }): Camera[] {
  return compact(
    (d?.features ?? []).map((f) => {
      const g = f.geometry;
      const c = (g?.type === "MultiPoint" ? (g.coordinates as number[][])?.[0] : (g?.coordinates as number[])) ?? [];
      const p = f.properties ?? {};
      return cam(TORONTO, p.REC_ID ?? "", [p.MAINROAD, p.CROSSROAD].filter(Boolean).join(" / "), c[1], c[0], { image: p.IMAGEURL ?? null });
    }),
  );
}

// 511 traveller sites (Iteris): one format, a free key each, added by the relay.
interface Iteris511Row {
  Id?: string | number;
  ID?: string | number;
  Name?: string;
  Roadway?: string;
  RoadwayName?: string;
  Direction?: string;
  DirectionOfTravel?: string;
  Location?: string;
  Latitude?: number;
  Longitude?: number;
  Url?: string;
  Disabled?: boolean;
  Blocked?: boolean;
  Views?: Array<{ Url?: string; Status?: string; Description?: string }>;
}
export function parse511(d: Iteris511Row[], src: { id: string; name: string }): Camera[] {
  return compact(
    (Array.isArray(d) ? d : []).map((c, i) => {
      if (c.Disabled || c.Blocked) return null;
      const views = (c.Views ?? [])
        .filter((v) => v.Url && !/disabled|off/i.test(v.Status ?? ""))
        .map((v, k) => ({ label: v.Description || `方向 ${k + 1}`, image: safeUrl(v.Url, { httpsOnly: true }) ?? "" }))
        .filter((v) => v.image);
      const name = [c.Name || c.Location, c.Roadway || c.RoadwayName, c.Direction || c.DirectionOfTravel].filter(Boolean).join(" · ");
      return cam(src, c.Id ?? c.ID ?? i, name, c.Latitude, c.Longitude, { image: views[0]?.image ?? c.Url ?? null, views: views.length > 1 ? views : undefined });
    }),
  );
}

// Windy's webcam directory (worldwide, the site's own key): asked for around
// the map centre, one half-degree cell at a time.
const WINDY = { id: "windy", name: "Windy 網路攝影機" };
interface WindyRow {
  webcamId?: number;
  title?: string;
  status?: string;
  location?: { latitude?: number; longitude?: number; city?: string };
  images?: { current?: { preview?: string; thumbnail?: string } };
  urls?: { detail?: string };
}
export function parseWindy(d: { webcams?: WindyRow[] }): Camera[] {
  return compact(
    (d?.webcams ?? []).map((w) =>
      w.status && w.status !== "active"
        ? null
        : cam(WINDY, w.webcamId ?? "", [w.title, w.location?.city].filter(Boolean).join("，"), w.location?.latitude, w.location?.longitude, {
            image: w.images?.current?.preview ?? w.images?.current?.thumbnail ?? null,
            page: safeUrl(w.urls?.detail, { httpsOnly: true }) ?? (w.webcamId ? `https://www.windy.com/webcams/${w.webcamId}` : null),
            refreshS: 300,
          }),
    ),
  );
}

const WINDY_CELL = 0.5;
const windyCells = new Map<string, { at: number; data: Promise<Camera[]> }>();

/** Traffic webcams in the half-degree cell around a point (cached for five minutes; image links expire). */
export function windyNear(lat: number, lng: number): { cell: string; data: Promise<Camera[]> } {
  const cy = Math.round(lat / WINDY_CELL) * WINDY_CELL;
  const cx = Math.round(lng / WINDY_CELL) * WINDY_CELL;
  const cell = `${cy.toFixed(1)},${cx.toFixed(1)}`;
  const hit = windyCells.get(cell);
  if (hit && Date.now() - hit.at < 5 * 60000) return { cell, data: hit.data };
  const q = new URLSearchParams({ nearby: `${cell},60`, categories: "traffic", include: "images,location,urls", limit: "50" });
  const data = getJson<{ webcams?: WindyRow[] }>(`https://api.windy.com/webcams/api/v3/webcams?${q}`, { route: "relay", timeout: 20000 }).then(parseWindy);
  windyCells.set(cell, { at: Date.now(), data });
  data.catch(() => windyCells.delete(cell));
  return {
    cell,
    data: data.then((cams) => cams.map((c) => ({ ...c, latest: () => windyNear(lat, lng).data.then((all) => all.find((x) => x.id === c.id)?.image ?? null) }))),
  };
}

// ---- Sources -----------------------------------------------------------------

const json = <T>(url: string, route: Route = "direct", headers?: Record<string, string>) => getJson<T>(url, { route, timeout: 20000, headers });

let sgCache: { at: number; data: Promise<Camera[]> } | null = null;
function singapore(): Promise<Camera[]> {
  // Each image URL is one frame; the list is re-read to get the next one.
  if (!sgCache || Date.now() - sgCache.at > 50000) {
    const data = json<Parameters<typeof parseSingapore>[0]>("https://api.data.gov.sg/v1/transport/traffic-images").then(parseSingapore);
    sgCache = { at: Date.now(), data };
    data.catch(() => (sgCache = null));
  }
  return sgCache.data.then((cams) => cams.map((c) => ({ ...c, latest: () => singapore().then((all) => all.find((x) => x.id === c.id)?.image ?? null) })));
}

const CALTRANS_DISTRICTS: Array<[number, Bounds]> = [
  [1, box(38.65, -124.3, 42.1, -122.5)],
  [2, box(39.67, -123.1, 42.1, -119.9)],
  [3, box(37.98, -122.26, 39.89, -119.86)],
  [4, box(36.82, -122.89, 38.63, -121.41)],
  [5, box(34.29, -122.12, 37.23, -119.39)],
  [6, box(34.72, -120.82, 37.43, -118.71)],
  [7, box(33.65, -119.39, 34.89, -117.59)],
  [8, box(33.34, -117.84, 35.7, -114.45)],
  [9, box(34.89, -119.55, 38.45, -117.77)],
  [10, box(36.88, -121.78, 38.51, -119.85)],
  [11, box(32.45, -117.49, 33.44, -115.4)],
  [12, box(33.3, -118.19, 34.04, -117.49)],
];

export const CAM_SOURCES: CamSource[] = [
  {
    ...HK,
    place: "香港",
    bbox: box(22.13, 113.82, 22.58, 114.45),
    minZoom: 8,
    load: async () => parseHongKong(await getText("https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.xml", { timeout: 20000 })),
  },
  { ...SG, place: "新加坡", bbox: box(1.15, 103.6, 1.48, 104.1), minZoom: 8, load: singapore },
  { ...NZ, place: "紐西蘭", bbox: box(-47.5, 166, -34, 179), minZoom: 5, load: async () => parseNewZealand(await json("https://trafficnz.info/service/traffic/rest/4/cameras/all", "relay", { accept: "application/json" })) },
  { ...NSW, place: "新南威爾斯", bbox: box(-37.6, 140.9, -28.1, 153.7), minZoom: 5, load: async () => parseNsw(await json("https://www.livetraffic.com/datajson/all-feeds-web.json", "relay")) },
  { ...FI, place: "芬蘭", bbox: box(59.5, 19.5, 70.1, 31.6), minZoom: 5, load: async () => parseFinland(await json("https://tie.digitraffic.fi/api/weathercam/v1/stations")) },
  { ...TFL, place: "倫敦", bbox: box(51.25, -0.6, 51.75, 0.35), minZoom: 8, load: async () => parseTfl(await json("https://api.tfl.gov.uk/Place/Type/JamCam")) },
  {
    ...DGT,
    place: "西班牙",
    bbox: box(27.6, -18.2, 43.9, 4.4),
    minZoom: 6,
    load: async () => parseSpain(await getText("https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml", { route: "relay", timeout: 30000 })),
  },
  { ...IS, place: "冰島", bbox: box(63.2, -24.6, 66.6, -13.4), minZoom: 5, load: async () => parseIceland(await json("https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1", "relay")) },
  { ...NYC, place: "紐約市", bbox: box(40.45, -74.3, 40.95, -73.65), minZoom: 8, load: async () => parseNyc(await json("https://webcams.nyctmc.org/api/cameras", "relay")) },
  ...CALTRANS_DISTRICTS.map(
    ([n, bbox]): CamSource => ({
      ...CALTRANS,
      id: `ca${n}`,
      place: "加州",
      bbox,
      minZoom: 7,
      load: async () => parseCaltrans(await json(`https://cwwp2.dot.ca.gov/data/d${n}/cctv/cctvStatusD${String(n).padStart(2, "0")}.json`), n),
    }),
  ),
  {
    ...IOWA,
    place: "愛荷華",
    bbox: box(40.3, -96.7, 43.6, -90.1),
    minZoom: 6,
    load: async () => parseIowa(await json("https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&outFields=Desc_,ImageURL&f=geojson")),
  },
  {
    ...MD,
    place: "馬里蘭",
    bbox: box(37.8, -79.5, 39.8, -75),
    minZoom: 7,
    load: async () => parseMaryland(await json("https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do", "relay")),
  },
  { ...BC, place: "卑詩省", bbox: box(48.2, -139.1, 60.1, -114), minZoom: 5, load: async () => parseDriveBc(await json("https://www.drivebc.ca/api/webcams/", "relay")) },
  { ...OTTAWA, place: "渥太華", bbox: box(44.9, -76.4, 45.6, -75.2), minZoom: 8, load: async () => parseOttawa(await json("https://traffic.ottawa.ca/beta/camera_list")) },
  { ...CALGARY, place: "卡加利", bbox: box(50.8, -114.4, 51.25, -113.85), minZoom: 8, load: async () => parseCalgary(await json("https://data.calgary.ca/resource/k7p9-kppz.json?$limit=2000")) },
  {
    ...TORONTO,
    place: "多倫多",
    bbox: box(43.55, -79.65, 43.9, -79.1),
    minZoom: 8,
    load: async () =>
      parseToronto(
        await json(
          "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson",
          "relay",
        ),
      ),
  },
  // These need the site's own key (Worker secret); without it the relay says 501 and they stay off.
  ...(
    [
      ["on511", "安大略省交通廳 511ON", "安大略", box(41.6, -95.2, 56.9, -74.3), "https://511on.ca/api/v2/get/cameras?format=json"],
      ["ab511", "亞伯達省交通廳 511 Alberta", "亞伯達", box(49, -120, 60, -110), "https://511.alberta.ca/api/v2/get/cameras?format=json"],
      ["ny511", "紐約州交通廳 511NY", "紐約州", box(40.4, -79.8, 45.1, -71.8), "https://511ny.org/api/getcameras?format=json"],
    ] as const
  ).map(
    ([id, name, place, bbox, url]): CamSource => ({ id, name, place, bbox, minZoom: 6, needsKey: true, load: async () => parse511(await json(url, "relay"), { id, name }) }),
  ),
];

/** Whether this browser plays HLS without a library (Safari, iPhone). */
export function hlsNative(): boolean {
  return typeof document !== "undefined" && document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
}

