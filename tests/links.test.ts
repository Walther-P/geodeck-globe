import { afterEach, describe, expect, it, vi } from "vitest";
import { extractUrl, isShortLink, parseMapUrl } from "../src/data/maplinks";
import { navigationUrl, searchPlaces } from "../src/data/places";
import { allowedHop, coordinatesFromHtml, hasCoordinates, resolvableStart } from "../worker/resolve";

describe("shared map links", () => {
  it("takes the pinned place from a Google Maps place URL, not the viewport", () => {
    const p = parseMapUrl(
      "https://www.google.com/maps/place/%E8%B5%A4%E5%B4%81%E6%A8%93/@22.9970,120.2010,17z/data=!3m1!4b1!4m6!3m5!1s0x346e76:0x1!8m2!3d22.997534!4d120.202568!16s%2Fm%2F0",
    );
    expect(p).toEqual({ lat: 22.997534, lng: 120.202568, title: "赤崁樓" });
  });

  it("reads coordinates and names from query-style links", () => {
    expect(parseMapUrl("https://maps.google.com/?q=22.99,120.2")).toMatchObject({ lat: 22.99, lng: 120.2 });
    expect(parseMapUrl("https://maps.google.com/?q=%E8%B5%A4%E5%B4%81%E6%A8%93,+%E5%8F%B0%E5%8D%97&ftid=0x1:0x2&entry=gps")).toEqual({
      query: "赤崁樓, 台南",
      title: "赤崁樓",
    });
    expect(parseMapUrl("https://www.google.com/maps/@25.0339,121.5645,15z")).toMatchObject({ lat: 25.0339, lng: 121.5645 });
    expect(parseMapUrl("https://maps.apple.com/?ll=22.99,120.2&q=%E8%B5%A4%E5%B4%81%E6%A8%93")).toEqual({ lat: 22.99, lng: 120.2, query: "赤崁樓", title: "赤崁樓" });
    expect(parseMapUrl("https://maps.apple.com/place?coordinate=25.03,121.56&name=101")).toMatchObject({ lat: 25.03, lng: 121.56 });
    expect(parseMapUrl("geo:22.99,120.2?q=22.99,120.2(%E8%B5%A4%E5%B4%81%E6%A8%93)".replace("%E8%B5%A4%E5%B4%81%E6%A8%93", "赤崁樓"))).toEqual({ lat: 22.99, lng: 120.2, title: "赤崁樓" });
  });

  it("unwraps consent pages and ignores links that aren't maps", () => {
    const inner = encodeURIComponent("https://www.google.com/maps/place/X/data=!3d1.5!4d2.5");
    expect(parseMapUrl(`https://consent.google.com/m?continue=${inner}`)).toMatchObject({ lat: 1.5, lng: 2.5 });
    expect(parseMapUrl("https://example.com/?q=22.99,120.2")).toBeNull();
    expect(parseMapUrl("not a url")).toBeNull();
  });

  it("recognises short links and pulls the link out of share text", () => {
    expect(isShortLink("https://maps.app.goo.gl/AbCd123")).toBe(true);
    expect(isShortLink("https://goo.gl/maps/AbCd123")).toBe(true);
    expect(isShortLink("https://goo.gl/other")).toBe(false);
    expect(parseMapUrl("https://maps.app.goo.gl/AbCd123")).toEqual({});
    expect(extractUrl("赤崁樓\n704台南市中西區民族路二段212號\nhttps://maps.app.goo.gl/AbCd123")).toBe("https://maps.app.goo.gl/AbCd123");
    expect(extractUrl("沒有連結")).toBeNull();
  });
});

describe("link resolver (Worker)", () => {
  it("only starts from Google Maps links and only follows Google hops", () => {
    expect(resolvableStart("https://maps.app.goo.gl/AbCd")).not.toBeNull();
    expect(resolvableStart("https://goo.gl/maps/AbCd")).not.toBeNull();
    expect(resolvableStart("https://www.google.com/maps?q=a")).not.toBeNull();
    expect(resolvableStart("https://maps.google.com.tw/?q=a")).not.toBeNull();
    for (const bad of ["https://goo.gl/xyz", "http://maps.app.goo.gl/x", "https://evil.example/maps", "https://www.google.com/search?q=a", "https://google.com.evil.example/maps"])
      expect(resolvableStart(bad)).toBeNull();
    expect(allowedHop(new URL("https://www.google.com/maps/place/x"))).toBe(true);
    expect(allowedHop(new URL("https://evil.example/"))).toBe(false);
  });

  it("knows when a URL already pins the place", () => {
    expect(hasCoordinates("https://www.google.com/maps/place/x/data=!3d22.9!4d120.2")).toBe(true);
    expect(hasCoordinates("https://maps.google.com/?q=22.9,120.2")).toBe(true);
    expect(hasCoordinates("https://maps.google.com/?q=%E8%B5%A4&ftid=0x1")).toBe(false);
  });

  it("reads the place position and name from a Google Maps page", () => {
    const html = `<meta content="赤崁樓 · 704台南市中西區民族路二段212號" property="og:title"><meta content="https://maps.google.com/maps/api/staticmap?center=22.9975%2C120.2026&amp;zoom=16" property="og:image">`;
    expect(coordinatesFromHtml(html)).toEqual({ lat: 22.9975, lng: 120.2026, title: "赤崁樓" });
    expect(coordinatesFromHtml(`window.APP_INITIALIZATION_STATE=[[[1500.2,121.5645,25.0339],[0,0,0]]]`)).toEqual({ lat: 25.0339, lng: 121.5645 });
    expect(coordinatesFromHtml("<html></html>")).toBeNull();
  });
});

describe("search and hand-off", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts Google results first and drops OSM duplicates of them", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          features: [
            { geometry: { coordinates: [120.2026, 22.9975] }, properties: { name: "赤崁樓" } },
            { geometry: { coordinates: [120.21, 22.99] }, properties: { name: "赤崁樓停車場" } },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const google = async () => [{ lat: 22.9976, lng: 120.2025, title: "赤崁樓", googleId: "ChIJ123", source: "Google" }];
    const r = await searchPlaces("赤崁樓", null, undefined, google);
    expect(r.places.map((p) => `${p.source}:${p.title}`)).toEqual(["Google:赤崁樓", "OpenStreetMap:赤崁樓停車場"]);
  });

  it("still returns OSM results when Google fails, and says why", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ features: [{ geometry: { coordinates: [120.2, 23] }, properties: { name: "A" } }] })));
    const r = await searchPlaces("A", null, undefined, async () => {
      throw new Error("金鑰無效");
    });
    expect(r.places).toHaveLength(1);
    expect(r.googleError).toBe("金鑰無效");
  });

  it("opens the exact Google venue when a place id is known", () => {
    const url = navigationUrl("google", { lat: 22.9976, lng: 120.2025, title: "赤崁樓", googleId: "ChIJ123" }, "driving");
    expect(url).toBe("https://www.google.com/maps/dir/?api=1&destination=%E8%B5%A4%E5%B4%81%E6%A8%93&travelmode=driving&destination_place_id=ChIJ123");
  });
});
