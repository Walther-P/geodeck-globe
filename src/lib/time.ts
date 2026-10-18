export type Freshness = "fresh" | "stale" | "unknown";

/** Parse feed timestamps; Taiwan feeds often omit the offset and mean +08:00. */
export function parseTime(v: unknown, assumeOffset = "+08:00"): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += assumeOffset;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function freshness(at: number | null, maxAgeMs: number, now = Date.now()): Freshness {
  if (at === null) return "unknown";
  return now - at <= maxAgeMs ? "fresh" : "stale";
}

export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return "時間未知";
  const s = Math.round((now - at) / 1000);
  if (s < -60) return "預報時間";
  if (s < 60) return "剛剛";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

export function clock(at: number, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }): string {
  return new Date(at).toLocaleTimeString("zh-TW", { hour12: false, ...opts });
}

export function dateTime(at: number): string {
  return new Date(at).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
