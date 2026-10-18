// Road cameras and speed-enforcement points bundled with the app.

import { getJson } from "../lib/net";
import { distance, inBounds, type Bounds, type Point } from "../lib/util";
import type { Camera } from "./tdx";

interface CameraCatalog {
  updatedAt: string;
  catalog: string;
  cameras: Array<{ id: string; lat: number; lng: number; name: string; image: string | null; mirror?: string | null; page: string | null }>;
}

let cameraCatalog: Promise<CameraCatalog> | null = null;

export function bundledCameras(): Promise<{ updatedAt: string; cameras: Camera[] }> {
  cameraCatalog ??= getJson<CameraCatalog>("./data/cameras-tw.json").catch((e) => {
    cameraCatalog = null;
    throw e;
  });
  return cameraCatalog.then((c) => ({
    updatedAt: c.updatedAt,
    cameras: c.cameras.map((x) => ({ ...x, source: x.image ? "公路主管機關" : "twipcam 轉載的政府公開影像" })),
  }));
}

export interface EnforcementPoint {
  id: string;
  lat: number;
  lng: number;
  name: string;
  direction: string;
  limit: number | null;
}

let enforcement: Promise<{ fetchedAt: string; points: EnforcementPoint[] }> | null = null;

export function enforcementPoints(): Promise<{ fetchedAt: string; points: EnforcementPoint[] }> {
  enforcement ??= getJson<{ fetchedAt: string; points: EnforcementPoint[] }>("./data/enforcement-tw.json").catch((e) => {
    enforcement = null;
    throw e;
  });
  return enforcement;
}

export function within<T extends Point>(rows: T[], view: Bounds): T[] {
  return rows.filter((r) => inBounds(r, view));
}

export function nearest<T extends Point>(rows: T[], p: Point, radiusM: number, limit = 6): Array<T & { distance: number }> {
  return rows
    .map((r) => ({ ...r, distance: distance(p, r) }))
    .filter((r) => r.distance <= radiusM)
    .sort((a, z) => a.distance - z.distance)
    .slice(0, limit);
}

/** Verified parking-lot cameras (entrance/interior), checked by hand. */
export interface ParkingCameraLink {
  parkingIds: string[];
  parkingName: string;
  image: string;
  coverage: "entrance" | "interior";
  verifiedAt: string;
  evidenceUrl: string;
  note: string;
}

let parkingCameras: Promise<ParkingCameraLink[]> | null = null;

export function parkingCameraLinks(now = Date.now()): Promise<ParkingCameraLink[]> {
  parkingCameras ??= getJson<{ links: ParkingCameraLink[] }>("./data/parking-cameras.json")
    .then((d) => d.links)
    .catch((e) => {
      parkingCameras = null;
      throw e;
    });
  // A link not re-checked for 90 days is retired (camera may have moved).
  return parkingCameras.then((links) => links.filter((l) => now - Date.parse(l.verifiedAt) <= 90 * 86400000));
}
