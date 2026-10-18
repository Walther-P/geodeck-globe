import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { isSameOriginRequest, matchRelayRule, RELAY_RULES } from "../worker/relay";
import { mask, normalizeKeys } from "../src/data/keys";
import { liveStatus, mergeLots, type CatalogLot } from "../src/data/parking";
import { defaultNavApp, navigationUrl, parsePhoton } from "../src/data/places";
import { citiesAt, inTaiwan } from "../src/data/taiwan";
import type { LiveLot } from "../src/data/tdx";
import { freshness, parseTime } from "../src/lib/time";
import { distance, escapeHtml, parseCoordinates, safeUrl } from "../src/lib/util";
import { tacticalStyle } from "../src/map/style";

describe("relay allowlist", () => {
  it("only forwards known public feeds", () => {
    expect(matchRelayRule("https://api.adsb.lol/v2/point/23.000/120.200/120", "GET")?.rule.id).toBe("adsb");
    expect(matchRelayRule("https://api.airplanes.live/v2/point/23.5/121/150", "GET")?.rule.id).toBe("airplanes-live");
    expect(matchRelayRule("https://opendata.adsb.fi/api/v2/lat/23.5/lon/121/dist/150", "GET")?.rule.id).toBe("adsb-fi");
    expect(matchRelayRule("https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle", "GET")?.rule.id).toBe("celestrak");
    expect(matchRelayRule("https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/CarPark/City/Tainan?$format=JSON", "GET")?.rule.keyed).toBe(true);
    expect(matchRelayRule("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", "POST")?.rule.id).toBe("tdx-token");
  });

  it("refuses everything else", () => {
    for (const url of [
      "https://evil.example/v2/point/1/2/3",
      "http://api.adsb.lol/v2/point/1/2/3",
      "https://api.adsb.lol/v2/hex/abc",
      "https://api.adsb.lol:8443/v2/point/1/2/3",
      "https://user:pw@celestrak.org/NORAD/elements/gp.php",
      "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
      "not a url",
    ])
      expect(matchRelayRule(url, "GET")).toBeNull();
    expect(matchRelayRule("https://api.adsb.lol/v2/point/1/2/3", "POST")).toBeNull();
  });

  it("never shares keyed responses between visitors", () => {
    for (const r of RELAY_RULES) if (r.keyed) expect(r.ttl).toBe(0);
  });

  it("serves only this site's own pages", () => {
    const self = "https://geodeck-globe.example.workers.dev";
    expect(isSameOriginRequest(new Headers({ "sec-fetch-site": "same-origin" }), self)).toBe(true);
    expect(isSameOriginRequest(new Headers({ "sec-fetch-site": "cross-site" }), self)).toBe(false);
    expect(isSameOriginRequest(new Headers({ origin: self }), self)).toBe(true);
    expect(isSameOriginRequest(new Headers({ origin: "https://other.example" }), self)).toBe(false);
    expect(isSameOriginRequest(new Headers(), self)).toBe(false);
  });
});

describe("keys", () => {
  it("strips whitespace pasted with a key and masks it for display", () => {
    expect(normalizeKeys({ tdxId: "  abc-123 \n", tdxSecret: "s e c", cwa: "CWA-1234-5678" })).toEqual({ tdxId: "abc-123", tdxSecret: "sec", cwa: "CWA-1234-5678" });
    expect(mask("")).toBe("未設定");
    expect(mask("CWA-1234-5678-ABCD")).toBe("CWA-••••ABCD");
  });
});

describe("parking honesty", () => {
  const now = Date.parse("2026-10-18T08:00:00Z");
  it("shows a count only while it is under five minutes old", () => {
    expect(liveStatus({ available: 12, updatedAt: now - 60000, full: false }, now)).toMatchObject({ label: "12", state: "fresh" });
    expect(liveStatus({ available: 12, updatedAt: now - 6 * 60000, full: false }, now)).toMatchObject({ label: "?", state: "stale" });
    expect(liveStatus({ available: 12, updatedAt: null, full: false }, now)).toMatchObject({ label: "?", state: "unknown" });
    expect(liveStatus({ available: null, updatedAt: now, full: false }, now)).toMatchObject({ label: "?" });
    expect(liveStatus({ available: 0, updatedAt: now, full: true }, now)).toMatchObject({ label: "滿", state: "full" });
    expect(liveStatus({ available: 3, updatedAt: now + 10 * 60000, full: false }, now).label).toBe("?");
  });

  it("drops a catalog lot that TDX already lists at the same spot", () => {
    const lot = (id: string, lat: number, lng: number, kind: CatalogLot["kind"] = "lot"): CatalogLot => ({ id, lat, lng, name: id, kind, total: null, rate: null, hours: null, address: "", access: null, source: "osm" });
    const live = [{ id: "tdx-1", lat: 22.99, lng: 120.2 } as LiveLot];
    const merged = mergeLots([lot("same", 22.9902, 120.2001), lot("far", 22.995, 120.2), lot("curb", 22.99, 120.2, "curb")], live);
    expect(merged.catalog.map((l) => l.id)).toEqual(["far", "curb"]);
  });
});

describe("places", () => {
  const dest = { lat: 22.997, lng: 120.2025, title: "赤崁樓" };
  it("hands off to navigation apps with the right modes", () => {
    expect(navigationUrl("google", dest, "transit")).toBe("https://www.google.com/maps/dir/?api=1&destination=22.997000%2C120.202500&travelmode=transit");
    expect(navigationUrl("apple", dest, "walking")).toContain("dirflg=w");
    expect(navigationUrl("naver", dest, "driving")).toMatch(/^nmap:\/\/route\/car\?dlat=22.997&dlng=120.2025&dname=/);
    expect(navigationUrl("waze", dest)).toContain("navigate=yes");
  });

  it("recommends NAVER in Korea and Google elsewhere unless the user chose", () => {
    expect(defaultNavApp({ lat: 37.56, lng: 126.97, title: "Seoul" }, "auto")).toBe("naver");
    expect(defaultNavApp(dest, "auto")).toBe("google");
    expect(defaultNavApp(dest, "apple")).toBe("apple");
  });

  it("parses Photon results", () => {
    const r = parsePhoton({ features: [{ geometry: { coordinates: [120.2025, 22.997] }, properties: { name: "赤崁樓", city: "臺南市", countrycode: "tw" } }, { geometry: {} }] });
    expect(r).toEqual([{ lat: 22.997, lng: 120.2025, title: "赤崁樓", subtitle: "臺南市", country: "TW" }]);
  });

  it("knows which TDX city a point is in", () => {
    expect(citiesAt({ lat: 22.997, lng: 120.2025 })[0].code).toBe("Tainan");
    expect(citiesAt({ lat: 25.034, lng: 121.5645 })[0].code).toBe("Taipei");
    expect(citiesAt({ lat: 24.43, lng: 118.32 })[0].code).toBe("KinmenCounty");
    expect(inTaiwan({ lat: 35.68, lng: 139.76 })).toBe(false);
  });
});

describe("helpers", () => {
  it("parses coordinates typed into search", () => {
    expect(parseCoordinates("22.997, 120.2025")).toEqual({ lat: 22.997, lng: 120.2025 });
    expect(parseCoordinates("geo:25.03,121.56")).toEqual({ lat: 25.03, lng: 121.56 });
    expect(parseCoordinates("22.997，120.2025")).toEqual({ lat: 22.997, lng: 120.2025 });
    expect(parseCoordinates("赤崁樓")).toBeNull();
    expect(parseCoordinates("95, 10")).toBeNull();
  });

  it("treats Taiwan feed times without an offset as +08:00", () => {
    expect(parseTime("2026-10-18 16:00:00")).toBe(Date.parse("2026-10-18T08:00:00Z"));
    expect(parseTime("2026-10-18T16:00:00Z")).toBe(Date.parse("2026-10-18T16:00:00Z"));
    expect(parseTime(1760774400)).toBe(1760774400000);
    expect(parseTime("")).toBeNull();
    expect(freshness(null, 1000)).toBe("unknown");
  });

  it("escapes HTML and only allows http(s) links from feeds", () => {
    expect(escapeHtml(`<img src=x onerror="a">`)).not.toContain("<");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("http://example.com", { httpsOnly: true })).toBeNull();
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("measures distance", () => {
    const d = distance({ lat: 22.997, lng: 120.2025 }, { lat: 25.034, lng: 121.5645 });
    expect(d).toBeGreaterThan(260000);
    expect(d).toBeLessThan(275000);
  });
});

describe("basemap style", () => {
  it("is a valid MapLibre style with a globe projection", () => {
    const style = tacticalStyle();
    expect(validateStyleMin(style as never)).toEqual([]);
    expect(style.projection).toEqual({ type: "globe" });
    expect(style.layers.find((l) => l.id === "land-fallback")).toBeTruthy();
  });
});
