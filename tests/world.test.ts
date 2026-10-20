import { describe, expect, it } from "vitest";
import { describeParking, osmName, osmRef } from "../src/data/osmparking";
import {
  CAM_SOURCES,
  parseCalgary,
  parseCaltrans,
  parseDriveBc,
  parseFinland,
  parseHongKong,
  parseIceland,
  parseMaryland,
  parseNewZealand,
  parseNsw,
  parseNyc,
  parseOttawa,
  parse511,
  parseWindy,
  parseSingapore,
  parseSpain,
  parseTfl,
  parseToronto,
  xmlText,
} from "../src/data/worldcams";
import { matchRelayRule, redirectWithinRule, relayCacheKeys, withSiteKey } from "../worker/relay";

// Rows trimmed from what each feed answered on 2026-10-20 (scripts/live-probe.mjs checks them daily).

describe("world road cameras", () => {
  it("reads Hong Kong's XML list", () => {
    const xml = `<image-list><image><key>H429F</key><region>香港島</region><district>南區</district><description>香港仔海傍道近魚市場 [H429F]</description><latitude>22.24845</latitude><longitude>114.1505</longitude><url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image><image><key>X</key><description>壞資料</description><latitude>0</latitude><longitude>0</longitude><url>https://tdcctv.data.one.gov.hk/X.JPG</url></image></image-list>`;
    const cams = parseHongKong(xml);
    expect(cams).toHaveLength(1);
    expect(cams[0]).toMatchObject({ id: "hk:H429F", name: "香港仔海傍道近魚市場", lat: 22.24845, image: "https://tdcctv.data.one.gov.hk/H429F.JPG", refreshS: 120, source: "香港運輸署" });
  });

  it("reads Spain's DATEX II devices, cameras only", () => {
    const xml = `<d2:payload><ns2:device xsi:type="fse:ExtendedDevice" id="176130" version="2"><ns2:typeOfDevice>camera</ns2:typeOfDevice><loc:roadDestination>BURGOS</loc:roadDestination><loc:roadName>A-62</loc:roadName><loc:latitude>42.2624</loc:latitude><loc:longitude>-3.9403</loc:longitude><lse:kilometerPoint>25.3</lse:kilometerPoint><lse:province>BURGOS</lse:province><fse:deviceUrl>https://etraffic.dgt.es/camarasEtraffic/176130.jpg</fse:deviceUrl></ns2:device><ns2:device id="9"><ns2:typeOfDevice>variableMessageSign</ns2:typeOfDevice><loc:latitude>40</loc:latitude><loc:longitude>-3</loc:longitude></ns2:device></d2:payload>`;
    const cams = parseSpain(xml);
    expect(cams).toHaveLength(1);
    expect(cams[0]).toMatchObject({ id: "dgt:176130", name: "A-62 公里 25.3（往 BURGOS，BURGOS）", lat: 42.2624, lng: -3.9403, image: "https://etraffic.dgt.es/camarasEtraffic/176130.jpg" });
    expect(xmlText("<a:b>x &amp; y</a:b>", "b")).toBe("x & y");
  });

  it("reads the JSON feeds", () => {
    expect(parseSingapore({ items: [{ cameras: [{ camera_id: "2701", image: "https://images.data.gov.sg/api/traffic-images/2026/10/a.jpg", location: { latitude: 1.447, longitude: 103.77 } }] }] })[0]).toMatchObject({
      id: "sg:2701",
      image: "https://images.data.gov.sg/api/traffic-images/2026/10/a.jpg",
    });
    const nz = parseNewZealand({
      response: {
        camera: [
          { id: 714, name: "SH1 Tinwald ", description: "South along Hinds Highway", latitude: -43.9196, longitude: 171.721, imageUrl: "/camera/714.jpg", offline: false },
          { id: 831, name: "Offline", latitude: -43.9, longitude: 171.7, imageUrl: "/camera/831.jpg", offline: true },
        ],
      },
    });
    expect(nz).toHaveLength(1);
    expect(nz[0].image).toBe("https://www.trafficnz.info/camera/714.jpg");
    expect(
      parseNsw([
        { id: "a", eventCategory: "liveCams", geometry: { coordinates: [151.1, -34.03] }, properties: { title: "5 Ways (Miranda)", href: "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg" } },
        { id: "b", eventCategory: "Roadwork", geometry: { coordinates: [151, -34] }, properties: {} },
      ]),
    ).toHaveLength(1);
    const fi = parseFinland({
      features: [
        { geometry: { coordinates: [23.99, 60.05, 0] }, properties: { id: "C01503", name: "kt51_Inkoo", collectionStatus: "GATHERING", presets: [{ id: "C0150301", inCollection: true }, { id: "C0150302", inCollection: true }] } },
        { geometry: { coordinates: [24, 61, 0] }, properties: { id: "C9", name: "x", collectionStatus: "REMOVED_TEMPORARILY", presets: [{ id: "C901" }] } },
      ],
    });
    expect(fi).toHaveLength(1);
    expect(fi[0]).toMatchObject({ name: "51 號公路 Inkoo", image: "https://weathercam.digitraffic.fi/C0150301.jpg", refreshS: 300 });
    expect(fi[0].views).toHaveLength(2);
    const tfl = parseTfl([
      {
        id: "JamCams_00002.00865",
        commonName: "A406 Billet Upass E",
        lat: 51.6,
        lon: -0.016,
        additionalProperties: [
          { key: "available", value: "true" },
          { key: "imageUrl", value: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg" },
          { key: "videoUrl", value: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.mp4" },
        ],
      },
    ]);
    expect(tfl[0]).toMatchObject({ id: "tfl:00002.00865", clip: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.mp4" });
    expect(parseIceland([{ Maelist_nr: 7001, Myndavel: "Hellisheiði", Skyring: "séð til vesturs", Slod: "https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg", Breidd: 64.02, Lengd: -21.34 }])[0].name).toBe(
      "Hellisheiði · séð til vesturs",
    );
    expect(parseNyc([{ id: "8a6b", name: "Central Park West @ 86 St", area: "Manhattan", latitude: 40.785, longitude: -73.969, isOnline: "false", imageUrl: "https://webcams.nyctmc.org/api/cameras/8a6b/image" }])).toHaveLength(0);
    const ca = parseCaltrans(
      {
        data: [
          {
            cctv: {
              index: "1",
              inService: "true",
              location: { locationName: "TV102 -- I-580 : West of SR-24", nearbyPlace: "Oakland", latitude: "37.82539", longitude: "-122.27291" },
              imageData: { static: { currentImageURL: "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102i580westofsr24/tv102i580westofsr24.jpg" } },
            },
          },
        ],
      },
      4,
    );
    expect(ca[0]).toMatchObject({ id: "ca4:1", name: "I-580 : West of SR-24，Oakland" });
    expect(parseDriveBc([{ id: 872, name: "McLeese Lake - W", is_on: true, should_appear: true, location: { coordinates: [-122.3, 52.43] }, links: { imageDisplay: "/images/872.jpg?t=1792491498" } }])[0].image).toBe(
      "https://www.drivebc.ca/images/872.jpg",
    );
    expect(parseOttawa([{ number: 2025, id: 309, description: "(MTO) Hwy 416 NB ramp to Hwy 417 East", latitude: 45.34, longitude: -75.81 }])[0].image).toBe("https://traffic.ottawa.ca/beta/camera?id=2025");
    expect(parseCalgary([{ camera_url: { url: "http://trafficcam.calgary.ca/loc86.jpg" }, camera_location: "Stoney Trail / Deerfoot Trail", quadrant: "SE", point: { coordinates: [-113.98, 50.9] } }])[0]).toMatchObject({
      id: "yyc:86",
      image: "https://trafficcam.calgary.ca/loc86.jpg",
    });
    expect(
      parseToronto({ features: [{ geometry: { type: "MultiPoint", coordinates: [[-79.38, 43.64]] }, properties: { REC_ID: 8001, IMAGEURL: "https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg", MAINROAD: "YORK ST", CROSSROAD: "BREMNER BLVD" } }] })[0],
    ).toMatchObject({ id: "yyz:8001", lat: 43.64, lng: -79.38, name: "YORK ST / BREMNER BLVD" });
  });

  it("plays Maryland's HLS only from its own streaming hosts", () => {
    const md = parseMaryland({
      data: [
        { id: "7a00", name: "I-270 & Old Hundred Rd", lat: 39.28, lon: -77.32, cctvIp: "strmr5.sha.maryland.gov", opStatus: "OK" },
        { id: "bad", name: "x", lat: 39, lon: -77, cctvIp: "evil.example", opStatus: "OK" },
      ],
    });
    expect(md).toHaveLength(1);
    expect(md[0]).toMatchObject({ image: null, video: "https://strmr5.sha.maryland.gov/rtplive/7a00/playlist.m3u8" });
  });

  it("only sends lists through the relay that it allows", () => {
    const relayed = [
      "https://trafficnz.info/service/traffic/rest/4/cameras/all",
      "https://www.livetraffic.com/datajson/all-feeds-web.json",
      "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml",
      "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1",
      "https://webcams.nyctmc.org/api/cameras",
      "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do",
      "https://www.drivebc.ca/api/webcams/",
      "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson",
    ];
    for (const url of relayed) expect(matchRelayRule(url, "GET")?.rule.ttl).toBeGreaterThan(0);
    for (const url of ["https://webcams.nyctmc.org/api/cameras/8a6b/image", "https://www.drivebc.ca/api/events/", "https://nap.dgt.es/datex2/v3/dgt/SituationPublication/x.xml"])
      expect(matchRelayRule(url, "GET")).toBeNull();
  });

  it("adds the site's own key only on the Worker, and only for its rule", () => {
    const windy = matchRelayRule("https://api.windy.com/webcams/api/v3/webcams?nearby=35.5,139.5,60&limit=5", "GET")!;
    expect(windy.rule.ttl).toBeGreaterThan(0);
    expect(withSiteKey(windy.url, windy.rule, {})).toBeNull();
    const sent = withSiteKey(windy.url, windy.rule, { WINDY_WEBCAMS_KEY: " abc " })!;
    expect(sent.headers).toEqual({ "x-windy-api-key": "abc" });
    expect(sent.url.toString()).toBe(windy.url.toString());
    const on = matchRelayRule("https://511on.ca/api/v2/get/cameras?format=json&key=visitor-supplied", "GET")!;
    const onSent = withSiteKey(on.url, on.rule, { ON511_KEY: "site" })!;
    expect(onSent.url.searchParams.get("key")).toBe("site");
    // The cache key is the page's URL, which never carries the site's key.
    expect(on.url.searchParams.get("key")).toBe("visitor-supplied");
    const plain = matchRelayRule("https://webcams.nyctmc.org/api/cameras", "GET")!;
    expect(withSiteKey(plain.url, plain.rule, { WINDY_WEBCAMS_KEY: "x" })).toEqual({ url: plain.url, headers: {} });
  });

  it("reads 511 sites and Windy", () => {
    const on = parse511(
      [
        { Id: "ON-1", Roadway: "Hwy 401", Direction: "Eastbound", Location: "Hwy 401 at Yonge", Latitude: 43.75, Longitude: -79.41, Views: [{ Url: "https://511on.ca/map/Cctv/1", Status: "Enabled", Description: "東向" }, { Url: "https://511on.ca/map/Cctv/2", Status: "Disabled" }] },
        { ID: 7, Name: "I-87 at Exit 1", Latitude: 41.0, Longitude: -73.9, Url: "https://511ny.org/map/Cctv/7", Disabled: false },
        { ID: 8, Name: "Off", Latitude: 41.0, Longitude: -73.9, Url: "https://511ny.org/map/Cctv/8", Disabled: true },
      ],
      { id: "on511", name: "511ON" },
    );
    expect(on).toHaveLength(2);
    expect(on[0]).toMatchObject({ id: "on511:ON-1", image: "https://511on.ca/map/Cctv/1", name: "Hwy 401 at Yonge · Hwy 401 · Eastbound" });
    expect(on[0].views).toBeUndefined();
    expect(on[1].image).toBe("https://511ny.org/map/Cctv/7");
    const w = parseWindy({
      webcams: [
        { webcamId: 1170166404, title: "Shibuya Crossing", status: "active", location: { latitude: 35.659, longitude: 139.7, city: "Tokyo" }, images: { current: { preview: "https://imgproxy.windy.com/_/preview/x.jpg" } }, urls: { detail: "https://www.windy.com/webcams/1170166404" } },
        { webcamId: 2, title: "Old", status: "inactive", location: { latitude: 35, longitude: 139 }, images: { current: { preview: "https://imgproxy.windy.com/_/preview/y.jpg" } } },
      ],
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: "windy:1170166404", name: "Shibuya Crossing，Tokyo", page: "https://www.windy.com/webcams/1170166404", refreshS: 300 });
  });

  it("follows a redirect only within the same allowed feed", () => {
    const es = matchRelayRule("https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v36.xml", "GET")!;
    expect(redirectWithinRule(es.url, "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml", es.rule)?.pathname).toBe("/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml");
    expect(redirectWithinRule(es.url, "/datex2/v3/dgt/DevicePublication/camaras_datex2_v38.xml", es.rule)?.host).toBe("nap.dgt.es");
    expect(redirectWithinRule(es.url, "https://evil.example/camaras_datex2_v37.xml", es.rule)).toBeNull();
    expect(redirectWithinRule(es.url, "https://nap.dgt.es/datex2/v3/dgt/SituationPublication/all.xml", es.rule)).toBeNull();
    expect(redirectWithinRule(es.url, null, es.rule)).toBeNull();
    const keyed = matchRelayRule("https://511on.ca/api/v2/get/cameras?format=json", "GET")!;
    expect(redirectWithinRule(keyed.url, "https://511on.ca/api/v2/get/cameras?format=xml", keyed.rule)).toBeNull();
  });

  it("keeps XML and JSON answers of the same feed apart in the relay cache", () => {
    const nz = new URL("https://trafficnz.info/service/traffic/rest/4/cameras/all");
    const json = relayCacheKeys(nz, "application/json");
    expect(relayCacheKeys(nz, "*/*").fresh).not.toBe(json.fresh);
    expect(relayCacheKeys(nz, "*/*").stale).not.toBe(json.stale);
    expect(relayCacheKeys(nz, "application/json")).toEqual(json);
    expect(json.fresh).not.toBe(json.stale);
  });

  it("gives every source a sane area and a unique id", () => {
    const ids = CAM_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CAM_SOURCES) {
      expect(s.bbox.south).toBeLessThan(s.bbox.north);
      expect(s.bbox.west).toBeLessThan(s.bbox.east);
    }
  });
});

describe("OpenStreetMap parking", () => {
  it("decodes OpenMapTiles feature ids", () => {
    expect(osmRef(1509203602)).toEqual({ type: "way", id: 150920360 });
    expect(osmRef(24253465341)).toEqual({ type: "node", id: 2425346534 });
    expect(osmRef("51")).toEqual({ type: "node", id: 5 });
    expect(osmRef(undefined)).toBeNull();
    expect(osmRef(1509203605)).toBeNull();
  });

  it("prefers Traditional Chinese names", () => {
    expect(osmName({ name: "タイムズ", "name:en": "Times" })).toBe("タイムズ");
    expect(osmName({ name: "Q-Park", "name:zh-Hant": "Q-Park 停車場" })).toBe("Q-Park 停車場");
    expect(osmName({})).toBe("");
  });

  it("turns tags into what a driver wants to know", () => {
    const d = describeParking({ amenity: "parking", parking: "multi-storey", capacity: "320", fee: "yes", charge: "£4.50/hour", opening_hours: "24/7", access: "customers", "addr:street": "Leicester Square", "addr:housenumber": "1" });
    expect(d).toMatchObject({ kind: "lot", closed: false, total: 320, rate: "收費 · £4.50/hour", hours: "24 小時", address: "Leicester Square 1" });
    expect(d.notes).toEqual(["限消費顧客使用", "立體停車場"]);
    expect(describeParking({ amenity: "parking", parking: "street_side", fee: "no" })).toMatchObject({ kind: "curb", name: "路邊停車", rate: "免費" });
    expect(describeParking({ amenity: "parking", access: "private" }).closed).toBe(true);
    expect(describeParking({ amenity: "parking", fee: "yes @ (Mo-Fr 08:00-18:00)" }).rate).toBe("收費（Mo-Fr 08:00-18:00）");
  });
});
