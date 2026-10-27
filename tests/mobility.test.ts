import { describe, expect, it } from "vitest";
import { bikeCount, bikeTime, networksNear, parseNetworks, parseStations } from "../src/data/bikes";
import { hasOpenFeed, joinTaipei, parseTainan, parseTaichung, parseTaipeiCounts, parseTaoyuan, taipeiTime } from "../src/data/cityparking";
import { describeCharger } from "../src/data/osmparking";
import { liveStatus, type CatalogLot } from "../src/data/parking";
import { nightRing, subsolarPoint, sunAltitude, terminatorLat } from "../src/data/sun";
import { matchRelayRule } from "../worker/relay";

// Rows trimmed from what each feed answered on 2026-10-27 (scripts/live-probe.mjs checks them daily).

describe("keyless city parking", () => {
  it("reads Taipei's CST as Taiwan time", () => {
    expect(taipeiTime("Tue Oct 27 17:40:00 CST 2026")).toBe(Date.parse("2026-10-27T09:40:00Z"));
    expect(taipeiTime("2026-10-27 17:40")).toBeNull();
  });

  it("joins Taipei's counts to catalog positions", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><DATA><UPDATETIME>Tue Oct 27 17:40:00 CST 2026</UPDATETIME><PARK><ID>TPE0001</ID><AVAILABLECAR>12</AVAILABLECAR><AVAILABLEMOTOR>-9</AVAILABLEMOTOR></PARK><PARK><ID>TPE0002</ID><AVAILABLECAR>-9</AVAILABLECAR></PARK><PARK><ID>TPE9999</ID><AVAILABLECAR>5</AVAILABLECAR></PARK></DATA>`;
    const counts = parseTaipeiCounts(xml);
    expect(counts.get("taipei-TPE0001")).toEqual({ available: 12, updatedAt: Date.parse("2026-10-27T09:40:00Z") });
    const lot = (id: string): CatalogLot => ({ id, lat: 25.04, lng: 121.51, name: id, kind: "lot", total: 100, rate: "30元/時", hours: null, address: "中正區", access: null, source: "taipei" });
    const live = joinTaipei(counts, [lot("taipei-TPE0001"), lot("taipei-TPE0002"), lot("taipei-TPE0003")]);
    expect(live.map((l) => [l.id, l.available, l.source, l.fare])).toEqual([
      ["taipei-TPE0001", 12, "taipei", "30元/時"],
      // -9: the lot does not report, so the sign says "?".
      ["taipei-TPE0002", null, "taipei", "30元/時"],
    ]);
  });

  it("reads Taoyuan with its swapped coordinate names", () => {
    const xml = `<parkingLots updatetime="2026-10-27 17:42:44"><parkingLot><parkId>P-DW-002</parkId><parkName>大溪停車場</parkName><address>大溪區</address><wgsX>24.88</wgsX><wgsY>121.28</wgsY><totalSpace>200</totalSpace><surplusSpace>37</surplusSpace><payGuide>30元/時</payGuide></parkingLot></parkingLots>`;
    expect(parseTaoyuan(xml)[0]).toMatchObject({ id: "taoyuan-P-DW-002", lat: 24.88, lng: 121.28, total: 200, available: 37, updatedAt: Date.parse("2026-10-27T09:42:44Z"), full: false });
  });

  it("reads Taichung's grouped lots and Tainan's lat,lng pairs", () => {
    const tc = parseTaichung([{ ParkingLots: [{ ID: "1003", Position: " 府後停車場 ", X: 120.68, Y: 24.14, TotalCar: 80, AvailableCar: 0, Updatetime: "2026-10-27 17:43:06" }] }]);
    expect(tc[0]).toMatchObject({ id: "taichung-1003", name: "府後停車場", lat: 24.14, lng: 120.68, available: 0, full: true });
    const tn = parseTainan([{ code: "A01", name: "府前停車場", car: "42", car_total: "120", update_time: "2026-10-27 17:36:01", lnglat: "22.9935,120.2032" }, { code: "B", lnglat: "" }]);
    expect(tn).toHaveLength(1);
    expect(tn[0]).toMatchObject({ id: "tainan-web-A01", lat: 22.9935, lng: 120.2032, available: 42, total: 120 });
    // Tainan's lots report every four to six minutes: one missed cycle is still the latest count.
    const at = Date.parse("2026-10-27T09:36:01Z");
    expect(liveStatus({ ...tn[0], updatedAt: at }, at + 8 * 60000).label).toBe("42");
    expect(liveStatus({ ...tn[0], updatedAt: at }, at + 11 * 60000)).toMatchObject({ label: "?", text: "資料超過 10 分鐘（上次 42 格），暫不採用" });
    // Taichung refreshes every minute, so the usual five minutes apply.
    expect(liveStatus({ ...tc[0], available: 5, full: false, updatedAt: at }, at + 6 * 60000).label).toBe("?");
    expect(["Taipei", "Taoyuan", "Taichung", "Tainan"].every(hasOpenFeed)).toBe(true);
    expect(hasOpenFeed("Kaohsiung")).toBe(false);
  });

  it("relays the city files that need it, and nothing else on those hosts", () => {
    for (const url of [
      "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml",
      "https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download",
      "https://parkweb.tainan.gov.tw/api/parking.php",
    ])
      expect(matchRelayRule(url, "GET")?.rule.keyed).toBe(false);
    expect(matchRelayRule("https://tcgbusfs.blob.core.windows.net/blobtcmsv/other.xml", "GET")).toBeNull();
    expect(matchRelayRule("https://parkweb.tainan.gov.tw/admin.php", "GET")).toBeNull();
  });
});

describe("bike share", () => {
  it("reads CityBikes networks and stations", () => {
    const nets = parseNetworks({ networks: [{ id: "youbike-taipei", name: "YouBike", location: { latitude: 25.04, longitude: 121.53, city: "Taipei", country: "TW" } }, { id: "bad", location: {} }] });
    expect(nets).toEqual([{ id: "youbike-taipei", name: "YouBike", city: "Taipei", country: "TW", lat: 25.04, lng: 121.53 }]);
    const st = parseStations("youbike-chiayi-city", {
      network: {
        stations: [
          { id: "00e4", name: "自由友忠路口", latitude: 23.48553, longitude: 120.44124, timestamp: "2026-10-27T09:38:48.394932+00:00Z", free_bikes: 7, empty_slots: 8, extra: { address: "自由路/友忠路口(東北側)", slots: 15, ebikes: 4, online: true } },
          { id: "x", name: "停用", latitude: 23.4, longitude: 120.4, timestamp: "2026-10-27T09:38:48Z", free_bikes: 3, empty_slots: 0, extra: { renting: 0 } },
        ],
      },
    });
    expect(st[0]).toMatchObject({ id: "youbike-chiayi-city:00e4", bikes: 7, ebikes: 4, docks: 8, slots: 15, online: true, updatedAt: Date.parse("2026-10-27T09:38:48.394Z") });
    expect(st[1].online).toBe(false);
    expect(bikeTime("nonsense")).toBeNull();
  });

  it("picks the systems around the view, nearest first", () => {
    const n = (id: string, lat: number, lng: number) => ({ id, name: id, city: "", country: "TW", lat, lng });
    const all = [n("youbike-new-taipei", 25.01, 121.46), n("youbike-taipei", 25.04, 121.53), n("youbike-kaohsiung", 22.63, 120.3)];
    const near = networksNear(all, { north: 25.05, south: 25.03, east: 121.53, west: 121.51 });
    expect(near.map((x) => x.id)).toEqual(["youbike-taipei", "youbike-new-taipei"]);
  });

  it("only labels recent counts", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    const at = (min: number) => now - min * 60000;
    expect(bikeCount({ bikes: 7, updatedAt: at(1), online: true }, now)).toEqual({ label: "7", state: "ok" });
    expect(bikeCount({ bikes: 1, updatedAt: at(1), online: true }, now).state).toBe("low");
    expect(bikeCount({ bikes: 0, updatedAt: at(1), online: true }, now)).toEqual({ label: "0", state: "empty" });
    expect(bikeCount({ bikes: 5, updatedAt: at(1), online: false }, now)).toEqual({ label: "停", state: "empty" });
    expect(bikeCount({ bikes: 7, updatedAt: at(20), online: true }, now)).toEqual({ label: "?", state: "old" });
    expect(bikeCount({ bikes: null, updatedAt: at(1), online: true }, now).label).toBe("?");
  });
});

describe("EV charging", () => {
  it("turns OpenStreetMap tags into sockets and fees", () => {
    const d = describeCharger({
      amenity: "charging_station",
      operator: "U-POWER",
      capacity: "4",
      "socket:type2_combo": "4",
      "socket:type2_combo:output": "180 kW",
      "socket:type2": "2",
      "socket:chademo": "no",
      fee: "yes",
      opening_hours: "24/7",
    });
    expect(d).toMatchObject({ name: "U-POWER", operator: "U-POWER", capacity: 4, rate: "收費", hours: "24 小時", closed: false });
    expect(d.sockets).toEqual([
      { label: "CCS2", count: 4, output: "180 kW" },
      { label: "Type 2（交流）", count: 2, output: "" },
    ]);
    expect(describeCharger({ amenity: "charging_station", scooter: "yes", motorcar: "no", access: "private" })).toMatchObject({ closed: true, notes: ["供機車使用"] });
  });
});

describe("day and night", () => {
  it("puts the sun over the Tropic of Cancer at the June solstice", () => {
    const sun = subsolarPoint(new Date("2026-06-21T04:00:00Z"));
    expect(sun.lat).toBeCloseTo(23.4, 0);
    // 04:00 UTC: local noon is near 120°E (equation of time is small in June).
    expect(sun.lng).toBeGreaterThan(118);
    expect(sun.lng).toBeLessThan(122);
  });

  it("draws each line where the sun stands at that altitude", () => {
    const sun = subsolarPoint(new Date("2026-10-27T09:00:00Z"));
    for (const elevation of [0, -6, -12, -18])
      for (const lng of [-150, -60, 0, 45, 135]) {
        const lat = terminatorLat(sun, lng, elevation);
        if (Math.abs(lat) < 89.9) expect(sunAltitude(sun, { lat, lng })).toBeCloseTo(elevation, 3);
      }
  });

  it("shades exactly the places where the sun is below each line", () => {
    const inside = (ring: Array<[number, number]>, x: number, y: number) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    for (const when of ["2026-10-27T09:00:00Z", "2026-06-21T20:00:00Z", "2026-03-20T15:00:00Z"]) {
      const sun = subsolarPoint(new Date(when));
      for (const elevation of [0, -6, -12, -18]) {
        const ring = nightRing(sun, elevation);
        for (let lat = -85; lat <= 85; lat += 10)
          for (let lng = -175; lng <= 175; lng += 10) {
            const alt = sunAltitude(sun, { lat, lng });
            // Right on a line the 2° steps of the ring decide; skip those.
            if (Math.abs(alt - elevation) < 2) continue;
            // The ring may run past ±180°; the map wraps it, so test the shifted copies too.
            const shaded = [-360, 0, 360].some((k) => inside(ring, lng + k, lat));
            expect([when, elevation, lat, lng, shaded]).toEqual([when, elevation, lat, lng, alt < elevation]);
          }
      }
    }
  });

  it("closes the night over the pole the sun cannot reach", () => {
    const winter = nightRing(subsolarPoint(new Date("2026-12-21T12:00:00Z")));
    expect(winter.at(-2)).toEqual([-180, 90]);
    expect(winter[0]).toEqual(winter.at(-1));
    const summer = nightRing(subsolarPoint(new Date("2026-06-21T12:00:00Z")));
    expect(summer.at(-2)).toEqual([-180, -90]);
  });
});
