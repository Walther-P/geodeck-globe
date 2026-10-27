import { describe, expect, it } from "vitest";
import { compassDeg, compassName, freewayRef, headingFromName, icelandicHeading, laneHeadings, leadingCompass } from "../src/data/heading";
import { normalizeCctv } from "../src/data/tdx";
import { parseDriveBc, parseIceland, parseNewZealand, parseNsw } from "../src/data/worldcams";

describe("which way a camera looks", () => {
  it("reads compass words in Chinese and English", () => {
    expect(["北", "東南", "N", "NE", "N-E", "NorthEast", "south west", "Westbound"].map(compassDeg)).toEqual([0, 135, 0, 45, 45, 45, 225, 270]);
    expect(compassDeg("up")).toBeNull();
    expect([0, 44, 46, 180, 359].map(compassName)).toEqual(["北", "東北", "東北", "南", "北"]);
  });

  it("takes a direction from a camera's name only when it says where it looks", () => {
    expect(headingFromName("台南市道路 民族路二段與北門路一段口南桿(向北)")).toBe(0);
    expect(headingFromName("台北市道路 243-復興北路427巷(往北)")).toBe(0);
    expect(headingFromName("新北市道路 北宜路 新烏路(北宜路-往東)")).toBe(90);
    expect(headingFromName("宜蘭縣道路 台2線 蘭陽博物館 頭城鎮烏石港入口處(6)-濱海路北往南方向全景")).toBe(180);
    expect(headingFromName("高雄市道路 大順、南屏(向西北)")).toBe(315);
    // Traffic direction, and a place name that starts with 北, are not a view.
    expect(headingFromName("台北市道路 220-忠孝東研究院路(車行往北)")).toBeNull();
    expect(headingFromName("高雄科學園區 211民治路往北嶺村方向")).toBeNull();
    expect(headingFromName("國道一號 181K+320 南向 南屯交流道到王田交流道")).toBeNull();
    expect(headingFromName("Anzac Parade at Goodwood Street looking north towards the city")).toBe(0);
    expect(headingFromName("Highway 1 at Evans Road overpass, looking south-east.")).toBe(135);
    expect(icelandicHeading("Hellisheiði séð til vesturs")).toBe(270);
    expect(icelandicHeading("Hellisheiði")).toBeNull();
    expect(leadingCompass("South along Hinds Highway from Lagmhor Rd")).toBe(180);
    expect(leadingCompass("North-west from Esmonde Rd")).toBe(315);
    expect(leadingCompass("SH75")).toBeNull();
  });

  it("follows a freeway carriageway's direction of travel from its neighbours", () => {
    expect(freewayRef("n1-s-181k-320")).toEqual({ road: "n1", dir: "s", km: 181.32 });
    expect(freewayRef("t2f-n-0k-524")).toEqual({ road: "t2f", dir: "n", km: 0.524 });
    expect(freewayRef("tpe-000071")).toBeNull();
    // A road running south-west as the kilometres go up, cameras on both carriageways.
    const at = (km: number) => ({ lat: 25 - km * 0.0064, lng: 121 - km * 0.0064 });
    const cams = [0, 1, 2, 3].flatMap((km) => [
      { id: `n9-s-${km}k-000`, ...at(km) },
      { id: `n9-n-${km}k-000`, ...at(km) },
    ]);
    const lanes = laneHeadings(cams);
    for (const km of [0, 1, 2, 3]) {
      expect(lanes.get(`n9-s-${km}k-000`)).toBeGreaterThan(215);
      expect(lanes.get(`n9-s-${km}k-000`)).toBeLessThan(230);
      expect(lanes.get(`n9-n-${km}k-000`)).toBeGreaterThan(35);
      expect(lanes.get(`n9-n-${km}k-000`)).toBeLessThan(50);
    }
    // A lone camera has no neighbours to follow.
    expect(laneHeadings([{ id: "n8-e-1k-000", lat: 23, lng: 120 }]).size).toBe(0);
  });

  it("keeps each feed's own direction field", () => {
    const nz = parseNewZealand({ response: { camera: [{ id: 714, name: "SH1 Tinwald", description: "South along Hinds Highway from Lagmhor Rd", latitude: -43.92, longitude: 171.72, imageUrl: "/camera/714.jpg" }] } });
    expect(nz[0]).toMatchObject({ heading: 180, headingKind: "view" });
    const nsw = parseNsw([
      { id: "a", eventCategory: "liveCams", geometry: { coordinates: [151.1, -34] }, properties: { title: "5 Ways", view: "looking west", direction: "N-E", href: "https://webcams.transport.nsw.gov.au/x.jpeg" } },
    ]);
    expect(nsw[0].heading).toBe(45);
    const bc = parseDriveBc([{ id: 556, name: "Evans Road - N", orientation: "SW", is_on: true, location: { coordinates: [-121.98, 49.14] }, links: { imageDisplay: "/images/556.jpg?t=1" } }]);
    expect(bc[0].heading).toBe(225);
    const is = parseIceland([{ Maelist_nr: 7001, Myndavel: "Hellisheiði", Skyring: "Hellisheiði séð til vesturs", Slod: "https://www.vegagerdin.is/x.jpg", Breidd: 64.02, Lengd: -21.34 }]);
    expect(is[0].heading).toBe(270);
    // No direction anywhere: no fan.
    const plain = parseNewZealand({ response: { camera: [{ id: 1, name: "SH75", description: "SH75", latitude: -43.6, longitude: 172.6, imageUrl: "/camera/1.jpg" }] } });
    expect(plain[0].heading).toBeUndefined();
    const tdx = normalizeCctv([{ CCTVID: "C1", PositionLat: 23, PositionLon: 120.2, SurveillanceDescription: "中華路與民生路口(向南)", VideoImageURL: "https://example.gov.tw/a.jpg" }], "Tainan");
    expect(tdx[0]).toMatchObject({ heading: 180, headingKind: "view" });
  });
});
