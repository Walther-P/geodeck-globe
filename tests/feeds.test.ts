import { describe, expect, it } from "vitest";
import { intensityRank, parseCyclones, parseQuakes, parseWarnings } from "../src/data/cwa";
import { cloudLayer, latestDomainTime, parseAdsb, parseTle, parseUsgs, satPosition } from "../src/data/sky";
import { normalizeBuses, normalizeCctv, normalizeLiveLots } from "../src/data/tdx";
import { parseForecast, rainOutlook } from "../src/data/weather";

const T0 = Date.parse("2026-10-18T08:00:00Z");

describe("TDX parking", () => {
  const parks = {
    CarParks: [
      { CarParkID: "A1", CarParkName: { Zh_tw: "府前停車場" }, CarParkPosition: { PositionLat: 22.99, PositionLon: 120.2 }, FareDescription: "30元/時" },
      { CarParkID: "B2", CarParkName: { Zh_tw: "未知場" }, CarParkPosition: { PositionLat: 22.98, PositionLon: 120.21 } },
      { CarParkID: "C3", CarParkPosition: { PositionLat: 0, PositionLon: 0 } },
    ],
  };
  const avail = {
    UpdateTime: "2026-10-18T15:59:00+08:00",
    ParkingAvailabilities: [
      {
        CarParkID: "A1",
        TotalSpaces: 300,
        AvailableSpaces: 80,
        DataCollectTime: "2026-10-18T15:58:30+08:00",
        Availabilities: [
          { SpaceType: 1, NumberOfSpaces: 200, AvailableSpaces: 12 },
          { SpaceType: 2, NumberOfSpaces: 100, AvailableSpaces: 68 },
        ],
      },
      { CarParkID: "B2", TotalSpaces: 50, AvailableSpaces: -9 },
    ],
  };

  it("prefers the car count, keeps per-lot times and treats negatives as unknown", () => {
    const lots = normalizeLiveLots(parks, avail, "Tainan");
    expect(lots).toHaveLength(2);
    const a = lots.find((l) => l.id.endsWith("A1"))!;
    expect(a).toMatchObject({ name: "府前停車場", total: 200, available: 12, fare: "30元/時", city: "Tainan" });
    expect(a.updatedAt).toBe(Date.parse("2026-10-18T07:58:30Z"));
    const b = lots.find((l) => l.id.endsWith("B2"))!;
    expect(b.available).toBeNull();
  });

  it("reads CCTV and drops rows without a position", () => {
    const cams = normalizeCctv(
      {
        CCTVs: [
          { CCTVID: "nfbCCTV-N1-S-10", VideoStreamURL: "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10", PositionLat: 25.1, PositionLon: 121.5, RoadName: "國道1號", LocationMile: "10K+500", RoadDirection: "S" },
          { CCTVID: "x", VideoStreamURL: "javascript:alert(1)", PositionLat: 25, PositionLon: 121 },
          { CCTVID: "y" },
        ],
      },
      "Freeway",
    );
    expect(cams).toHaveLength(2);
    expect(cams[0].name).toBe("國道1號 10K+500 南向");
    expect(cams[0].image).toContain("freeway.gov.tw");
    expect(cams[1].image).toBeNull();
  });

  it("keeps the newest fix per bus and skips buses out of service", () => {
    const rows = normalizeBuses([
      { PlateNumb: "KKA-1", RouteName: { Zh_tw: "2" }, BusPosition: { PositionLat: 22.99, PositionLon: 120.2 }, GPSTime: "2026-10-18T16:00:00+08:00" },
      { PlateNumb: "KKA-1", RouteName: { Zh_tw: "2" }, BusPosition: { PositionLat: 22.98, PositionLon: 120.21 }, GPSTime: "2026-10-18T15:59:00+08:00" },
      { PlateNumb: "KKA-2", BusPosition: { PositionLat: 22.9, PositionLon: 120.1 }, BusStatus: 99 },
      { PlateNumb: "KKA-3", BusPosition: { PositionLat: 22.9, PositionLon: 120.1 }, DutyStatus: 2 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "KKA-1", route: "2", lat: 22.99 });
  });
});

describe("CWA", () => {
  it("lists active warnings per county", () => {
    const w = parseWarnings({
      location: [
        { locationName: "臺南市", hazardConditions: { hazards: [{ info: { phenomena: "大雨", significance: "特報" }, validTime: { startTime: "2026-10-18 08:00:00", endTime: "2026-10-18 20:00:00" } }] } },
        { locationName: "臺北市", hazardConditions: { hazards: [] } },
      ],
    });
    expect(w).toEqual([{ area: "臺南市", phenomena: "大雨", significance: "特報", start: Date.parse("2026-10-18T00:00:00Z"), end: Date.parse("2026-10-18T12:00:00Z") }]);
  });

  it("reads earthquake reports in either key casing", () => {
    const upper = parseQuakes({
      Earthquake: [
        {
          EarthquakeNo: 115123,
          ReportContent: "10/18-15:20花蓮縣近海發生規模5.1有感地震",
          ReportImageURI: "https://scweb.cwa.gov.tw/x.png",
          EarthquakeInfo: { OriginTime: "2026-10-18 15:20:00", FocalDepth: 18.2, Epicenter: { Location: "花蓮縣政府北北東方 21 公里", EpicenterLatitude: 24.15, EpicenterLongitude: 121.7 }, EarthquakeMagnitude: { MagnitudeValue: 5.1 } },
          Intensity: { ShakingArea: [{ AreaIntensity: "3級" }, { AreaIntensity: "4級" }, { AreaIntensity: "1級" }] },
        },
      ],
    });
    expect(upper[0]).toMatchObject({ id: "115123", magnitude: 5.1, depthKm: 18.2, maxIntensity: "4級", lat: 24.15 });
    expect(upper[0].time).toBe(Date.parse("2026-10-18T07:20:00Z"));
    const lower = parseQuakes({ earthquake: [{ earthquakeNo: 1, earthquakeInfo: { originTime: "2026-10-18 15:20:00", epicenter: { epicenterLatitude: 24, epicenterLongitude: 121.5 } } }] });
    expect(lower[0].lat).toBe(24);
    expect(intensityRank("5強")).toBeGreaterThan(intensityRank("5弱"));
    expect(intensityRank("5弱")).toBeGreaterThan(intensityRank("4級"));
  });

  it("builds typhoon tracks with forecast times from init + tau", () => {
    const c = parseCyclones({
      tropicalCyclones: {
        tropicalCyclone: [
          {
            typhoonName: "KONG-REY",
            cwaTyphoonName: "康芮",
            cwaTyNo: "21",
            analysisData: { fix: [{ fixTime: "2026-10-18T08:00:00+08:00", coordinate: "123.1,20.5", maxWindSpeed: "45", circleOf15Ms: { radius: "250" } }] },
            forecastData: { fix: [{ initTime: "2026-10-18T08:00:00+08:00", tau: "24", coordinate: "121.9,22.4", maxWindSpeed: "48" }] },
          },
        ],
      },
    });
    expect(c[0].name).toBe("康芮");
    expect(c[0].fixes[0]).toMatchObject({ lng: 123.1, lat: 20.5, radius15Km: 250, forecast: false });
    expect(c[0].fixes[1].time).toBe(Date.parse("2026-10-19T00:00:00Z"));
  });
});

describe("weather", () => {
  const quarter = [...Array(12)].map((_, i) => T0 / 1000 + i * 900);
  const raw = (mm: number[]) => ({
    utc_offset_seconds: 28800,
    current: { time: T0 / 1000, temperature_2m: 27, weather_code: 2, is_day: 1 },
    minutely_15: { time: quarter, precipitation: mm },
    hourly: { time: [T0 / 1000], temperature_2m: [27], precipitation_probability: [60], precipitation: [1.2], weather_code: [61] },
  });

  it("says when rain starts", () => {
    const f = parseForecast(raw([0, 0, 0.3, 1, 1, 0, 0, 0, 0, 0, 0, 0]), T0);
    expect(rainOutlook(f, T0 + 60000).text).toBe("約 30 分鐘後開始下雨");
  });

  it("says when rain eases and when there is none", () => {
    expect(rainOutlook(parseForecast(raw([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), T0), T0 + 60000).text).toMatch(/正在下雨，約 30 分鐘後趨緩/);
    expect(rainOutlook(parseForecast(raw(Array(12).fill(0)), T0), T0 + 60000)).toMatchObject({ level: "dry" });
  });

  it("does not call missing data dry", () => {
    const f = parseForecast({ ...raw([]), minutely_15: {} }, T0);
    expect(rainOutlook(f, T0).level).toBe("unknown");
  });
});

describe("sky feeds", () => {
  it("parses aircraft, keeping ground traffic flagged", () => {
    const a = parseAdsb({
      ac: [
        { hex: "8964a1", flight: "CAL7  ", lat: 25.08, lon: 121.23, alt_baro: 4200, gs: 180, track: 230 },
        { hex: "8964a2", lat: 25.07, lon: 121.23, alt_baro: "ground" },
        { hex: "nopos" },
      ],
    });
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ callsign: "CAL7", altFt: 4200, onGround: false });
    expect(a[1]).toMatchObject({ onGround: true, altFt: null });
  });

  it("parses USGS quakes", () => {
    const q = parseUsgs({ features: [{ id: "us1", geometry: { coordinates: [121.6, 23.9, 10] }, properties: { mag: 5.1, time: T0, place: "Taiwan", url: "https://earthquake.usgs.gov/x" } }] });
    expect(q[0]).toMatchObject({ id: "usgs-us1", magnitude: 5.1, depthKm: 10, lat: 23.9, lng: 121.6 });
  });

  it("propagates an ISS element set to a plausible orbit", () => {
    const sats = parseTle(
      "ISS (ZARYA)\n1 25544U 98067A   26291.33333333  .00016717  00000-0  10270-3 0  9005\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50000000563537\nBROKEN\n1 garbage\n",
    );
    expect(sats).toHaveLength(1);
    const p = satPosition(sats[0], new Date("2026-10-18T09:00:00Z"))!;
    expect(p.altKm).toBeGreaterThan(300);
    expect(p.altKm).toBeLessThan(500);
    expect(Math.abs(p.lat)).toBeLessThanOrEqual(52);
  });

  it("reads the last time from a GIBS DescribeDomains reply", () => {
    const xml = `<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-01T00:00:00Z/2026-10-18T07:30:00Z/PT10M</Domain></DimensionDomain></Domains>`;
    expect(latestDomainTime(xml)).toBe("2026-10-18T07:30:00Z");
    expect(latestDomainTime("<x/>")).toBeNull();
    expect(cloudLayer(121)).toMatch(/^Himawari/);
    expect(cloudLayer(-120)).toMatch(/^GOES-West/);
  });
});
