// Open-Meteo forecast and air quality (free, no key, global).

import { getJson } from "../lib/net";
import { finite, type Point } from "../lib/util";

export interface HourRow {
  at: number;
  temp: number | null;
  rainChance: number | null;
  /** mm in the hour ending at `at` (model forecast). */
  rainMm: number | null;
  code: number | null;
}

export interface Forecast {
  at: number;
  temp: number | null;
  feels: number | null;
  humidity: number | null;
  windKmh: number | null;
  code: number | null;
  isDay: boolean;
  /** 15-minute precipitation for the next ~3 hours. */
  next: Array<{ at: number; mm: number | null }>;
  hours: HourRow[];
  utcOffset: number;
}

const val = (a: unknown, i: number): number | null => {
  const v = Array.isArray(a) ? a[i] : undefined;
  return finite(v) ? v : null;
};

interface OpenMeteo {
  utc_offset_seconds?: number;
  current?: Record<string, number>;
  minutely_15?: { time?: number[]; precipitation?: number[] };
  hourly?: { time?: number[]; temperature_2m?: number[]; precipitation_probability?: number[]; precipitation?: number[]; weather_code?: number[] };
}

export function parseForecast(d: OpenMeteo, now = Date.now()): Forecast {
  const c = d.current ?? {};
  const m = d.minutely_15 ?? {};
  const h = d.hourly ?? {};
  const next = (m.time ?? [])
    .map((t, i) => ({ at: t * 1000, mm: val(m.precipitation, i) }))
    .filter((x) => x.at >= now - 15 * 60000)
    .slice(0, 12);
  const hours = (h.time ?? [])
    .map((t, i) => ({
      at: t * 1000,
      temp: val(h.temperature_2m, i),
      rainChance: val(h.precipitation_probability, i),
      rainMm: val(h.precipitation, i),
      code: val(h.weather_code, i),
    }))
    .filter((x) => x.at >= now - 3600000)
    .slice(0, 24);
  return {
    at: finite(c.time) ? c.time * 1000 : now,
    temp: finite(c.temperature_2m) ? c.temperature_2m : null,
    feels: finite(c.apparent_temperature) ? c.apparent_temperature : null,
    humidity: finite(c.relative_humidity_2m) ? c.relative_humidity_2m : null,
    windKmh: finite(c.wind_speed_10m) ? c.wind_speed_10m : null,
    code: finite(c.weather_code) ? c.weather_code : null,
    isDay: c.is_day !== 0,
    next,
    hours,
    utcOffset: d.utc_offset_seconds ?? 0,
  };
}

export async function forecast(p: Point, signal?: AbortSignal): Promise<Forecast> {
  const q = new URLSearchParams({
    latitude: p.lat.toFixed(4),
    longitude: p.lng.toFixed(4),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    minutely_15: "precipitation",
    forecast_minutely_15: "12",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code",
    forecast_days: "2",
    timezone: "auto",
    timeformat: "unixtime",
  });
  return parseForecast(await getJson<OpenMeteo>(`https://api.open-meteo.com/v1/forecast?${q}`, { signal }));
}

export interface Air {
  aqi: number | null;
  pm25: number | null;
}

export async function air(p: Point, signal?: AbortSignal): Promise<Air> {
  const q = new URLSearchParams({ latitude: p.lat.toFixed(4), longitude: p.lng.toFixed(4), current: "us_aqi,pm2_5", timezone: "auto" });
  const d = await getJson<{ current?: { us_aqi?: number; pm2_5?: number } }>(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`, { signal });
  return { aqi: finite(d.current?.us_aqi) ? d.current.us_aqi : null, pm25: finite(d.current?.pm2_5) ? d.current.pm2_5 : null };
}

/** One sentence about rain in the next three hours, from 15-minute steps. */
export function rainOutlook(f: Forecast, now = Date.now()): { text: string; level: "dry" | "rain" | "unknown" } {
  const known = f.next.filter((x) => x.mm !== null);
  if (!known.length) return { text: "降雨資料未知", level: "unknown" };
  const wet = (x: { mm: number | null }) => (x.mm ?? 0) >= 0.1;
  const current = known.find((x) => x.at <= now && x.at + 15 * 60000 > now) ?? known[0];
  if (wet(current)) {
    const stop = known.find((x) => x.at > now && !wet(x));
    return { text: stop ? `正在下雨，約 ${minutes(stop.at - now)}後趨緩` : "正在下雨，三小時內持續", level: "rain" };
  }
  const start = known.find((x) => x.at > now && wet(x));
  if (start) return { text: `約 ${minutes(start.at - now)}後開始下雨`, level: "rain" };
  return { text: "三小時內無明顯降雨", level: "dry" };
}

function minutes(ms: number): string {
  const m = Math.max(5, Math.round(ms / 60000 / 5) * 5);
  return m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分鐘`;
}

const CODES: Array<[number[], string, string]> = [
  [[0], "晴", "☀"],
  [[1], "大致晴朗", "🌤"],
  [[2], "多雲", "⛅"],
  [[3], "陰", "☁"],
  [[45, 48], "霧", "🌫"],
  [[51, 53, 55, 56, 57], "毛毛雨", "🌦"],
  [[61, 63, 80, 81], "雨", "🌧"],
  [[65, 82, 66, 67], "大雨", "🌧"],
  [[71, 73, 75, 77, 85, 86], "雪", "🌨"],
  [[95, 96, 99], "雷雨", "⛈"],
];

export function weatherLabel(code: number | null, isDay = true): { text: string; icon: string } {
  if (code === null) return { text: "天氣未知", icon: "·" };
  const hit = CODES.find(([codes]) => codes.includes(code));
  if (!hit) return { text: "天氣未知", icon: "·" };
  const icon = !isDay && code <= 1 ? "☾" : hit[2];
  return { text: hit[1], icon };
}

export function aqiLabel(aqi: number | null): { text: string; level: "good" | "moderate" | "bad" | "unknown" } {
  if (aqi === null) return { text: "空品未知", level: "unknown" };
  if (aqi <= 50) return { text: "良好", level: "good" };
  if (aqi <= 100) return { text: "普通", level: "moderate" };
  if (aqi <= 150) return { text: "敏感族群不健康", level: "bad" };
  return { text: "不健康", level: "bad" };
}
