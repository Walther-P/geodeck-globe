// Upcoming rocket launches (The Space Devs Launch Library 2, free tier).

import { getJson } from "../lib/net";
import { parseTime } from "../lib/time";
import { num, point, safeUrl } from "../lib/util";

export interface Launch {
  id: string;
  name: string;
  /** No-earlier-than time (ms). */
  net: number | null;
  status: string;
  statusName: string;
  provider: string;
  mission: string;
  pad: string;
  location: string;
  lat: number | null;
  lng: number | null;
  url: string | null;
}

interface LlLaunch {
  id?: string;
  name?: string;
  net?: string;
  status?: { abbrev?: string; name?: string };
  launch_service_provider?: { name?: string };
  mission?: { name?: string; description?: string } | null;
  pad?: { name?: string; latitude?: number | string; longitude?: number | string; location?: { name?: string } };
  url?: string;
  vid_urls?: Array<{ url?: string }>;
}

export function parseLaunches(d: { results?: LlLaunch[] }): Launch[] {
  const out: Launch[] = [];
  for (const l of d.results ?? []) {
    if (!l.id || !l.name) continue;
    const pos = point(num(l.pad?.latitude), num(l.pad?.longitude));
    out.push({
      id: l.id,
      name: l.name,
      net: parseTime(l.net),
      status: l.status?.abbrev ?? "",
      statusName: l.status?.name ?? "",
      provider: l.launch_service_provider?.name ?? "",
      mission: l.mission?.description ?? l.mission?.name ?? "",
      pad: l.pad?.name ?? "",
      location: l.pad?.location?.name ?? "",
      lat: pos?.lat ?? null,
      lng: pos?.lng ?? null,
      url: safeUrl(l.vid_urls?.[0]?.url, { httpsOnly: true }),
    });
  }
  return out.sort((a, z) => (a.net ?? Infinity) - (z.net ?? Infinity));
}

let cached: { at: number; launches: Launch[] } | null = null;

export async function upcomingLaunches(): Promise<Launch[]> {
  if (cached && Date.now() - cached.at < 30 * 60000) return cached.launches;
  const d = await getJson<{ results?: LlLaunch[] }>("https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=12&mode=normal", {
    route: "direct-then-relay",
    timeout: 15000,
  });
  cached = { at: Date.now(), launches: parseLaunches(d) };
  return cached.launches;
}

/** "T-2 天 5 小時" / "T-35 分" / "已發射？" */
export function countdown(net: number | null, now = Date.now()): string {
  if (net === null) return "時間未定";
  const m = Math.round((net - now) / 60000);
  if (m < -60) return "應已發射";
  if (m <= 0) return "發射窗口中";
  if (m < 60) return `T-${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 48) return `T-${h} 小時 ${m % 60} 分`;
  return `T-${Math.floor(h / 24)} 天 ${h % 24} 小時`;
}
