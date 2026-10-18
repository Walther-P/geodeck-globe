import { describe, expect, it } from "vitest";
import { countdown, parseLaunches } from "../src/data/launches";
import { passIcs, passesOf, sunElevation, sunlit } from "../src/data/passes";
import { DEAD_RECKON_S, extrapolate, parseAdsb, parseTle, type Aircraft } from "../src/data/sky";

const ISS = parseTle(`ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`)[0];
const TAIPEI = { lat: 25.03, lng: 121.56 };

describe("sky above the observer", () => {
  it("puts the sun high at local noon and below the horizon at midnight", () => {
    expect(sunElevation(TAIPEI, new Date("2026-06-21T04:00:00Z"))).toBeGreaterThan(80);
    expect(sunElevation(TAIPEI, new Date("2026-06-21T16:00:00Z"))).toBeLessThan(-40);
  });

  it("knows when a satellite is in Earth's shadow", () => {
    const sun = { x: 1.5e8, y: 0, z: 0 };
    expect(sunlit({ x: 7000, y: 0, z: 0 }, sun)).toBe(true);
    expect(sunlit({ x: -7000, y: 0, z: 0 }, sun)).toBe(false);
    expect(sunlit({ x: -7000, y: 7000, z: 0 }, sun)).toBe(true);
  });

  it("finds ISS passes over Taipei with sane shapes", () => {
    const from = Date.UTC(2024, 0, 1, 12);
    const passes = passesOf(ISS, TAIPEI, from, 48);
    expect(passes.length).toBeGreaterThanOrEqual(2);
    for (const p of passes) {
      expect(p.name).toBe("國際太空站");
      expect(p.rise).toBeLessThanOrEqual(p.peak);
      expect(p.peak).toBeLessThanOrEqual(p.set);
      expect(p.set - p.rise).toBeLessThan(15 * 60000);
      expect(p.maxElevation).toBeGreaterThanOrEqual(10);
      expect(p.riseAzimuth).toBeGreaterThanOrEqual(0);
    }
  });

  it("writes a calendar entry with a reminder", () => {
    const ics = passIcs({ id: "25544", name: "國際太空站", rise: Date.UTC(2026, 9, 18, 11, 42), set: Date.UTC(2026, 9, 18, 11, 48), peak: Date.UTC(2026, 9, 18, 11, 45), maxElevation: 67.4, riseAzimuth: 315, setAzimuth: 135, visible: true }, "從西北升起, 最高 67°");
    expect(ics).toContain("DTSTART:20261018T114200Z");
    expect(ics).toContain("SUMMARY:國際太空站過境（最高 67°）");
    expect(ics).toContain("DESCRIPTION:從西北升起\\, 最高 67°");
    expect(ics).toContain("TRIGGER:-PT5M");
  });
});

describe("launches", () => {
  it("reads Launch Library rows and sorts by time", () => {
    const rows = parseLaunches({
      results: [
        { id: "b", name: "Falcon 9 | Starlink", net: "2026-10-20T03:00:00Z", status: { abbrev: "Go", name: "Go for Launch" }, launch_service_provider: { name: "SpaceX" }, pad: { name: "SLC-40", latitude: "28.56", longitude: "-80.57", location: { name: "Cape Canaveral, FL, USA" } } },
        { id: "a", name: "Long March 2F | Shenzhou", net: "2026-10-19T01:00:00Z", status: { abbrev: "TBC" }, pad: { name: "LC-43/91", latitude: 40.96, longitude: 100.29 } },
        { name: "no id" },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[1]).toMatchObject({ provider: "SpaceX", lat: 28.56, lng: -80.57, status: "Go", location: "Cape Canaveral, FL, USA" });
  });

  it("counts down in words", () => {
    const now = Date.UTC(2026, 9, 18);
    expect(countdown(now + 35 * 60000, now)).toBe("T-35 分");
    expect(countdown(now + 5 * 3600000 + 10 * 60000, now)).toBe("T-5 小時 10 分");
    expect(countdown(now + 3 * 86400000 + 2 * 3600000, now)).toBe("T-3 天 2 小時");
    expect(countdown(null, now)).toBe("時間未定");
  });
});

describe("aircraft between updates", () => {
  const now = Date.UTC(2026, 9, 18, 12);
  it("dates positions from the feed's clock and carries them along the track", () => {
    const [a] = parseAdsb({ now, ac: [{ hex: "abc", lat: 25, lon: 121, gs: 400, track: 90, seen_pos: 2 }] });
    expect(a.at).toBe(now - 2000);
    const p = extrapolate(a, now + 58000, now);
    expect(p.lat).toBeCloseTo(25, 5);
    expect(p.lng).toBeGreaterThan(121.06);
    expect(p.stale).toBe(false);
  });

  it("stops carrying a position forward once it is too old", () => {
    const a: Aircraft = { id: "x", callsign: "", reg: "", type: "", lat: 25, lng: 121, altFt: 30000, onGround: false, speedKt: 400, track: 0, seen: 0, at: now };
    const far = extrapolate(a, now + (DEAD_RECKON_S + 300) * 1000, now);
    expect(far.stale).toBe(true);
    expect(far.lat).toBeCloseTo(extrapolate(a, now + DEAD_RECKON_S * 1000, now).lat, 6);
  });
});

describe("view links", () => {
  it("round-trips the camera, lenses, mode, map and target", async () => {
    const { readViewLink, viewLink } = await import("../src/ui/share");
    const url = viewLink("https://x.example/", { lat: 25.03312, lng: 121.56541, zoom: 9.46, bearing: -30, pitch: 45.2, lenses: ["sky", "weather"], fx: "nvg", map: "g-sat", track: { kind: "plane", id: "8964a1" } });
    expect(url).toBe("https://x.example/?c=25.0331,121.5654&z=9.5&b=330&p=45&l=sky.weather&fx=nvg&m=g-sat&t=plane:8964a1");
    expect(readViewLink(new URL(url).search)).toEqual({ lat: 25.0331, lng: 121.5654, zoom: 9.5, bearing: 330, pitch: 45, lenses: ["sky", "weather"], fx: "nvg", map: "g-sat", track: { kind: "plane", id: "8964a1" } });
  });

  it("ignores links that are not views and anything it does not know", async () => {
    const { readViewLink } = await import("../src/ui/share");
    expect(readViewLink("?q=赤崁樓")).toBeNull();
    expect(readViewLink("?c=999,1")).toBeNull();
    const v = readViewLink("?c=23,121&l=sky.evil&fx=<script>&m=nope&t=ship:1&p=99")!;
    expect(v).toMatchObject({ lenses: ["sky"], fx: "", map: null, track: null, pitch: 70, zoom: 8 });
  });
});
