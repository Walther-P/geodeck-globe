import type { Bounds, Point } from "../lib/util";
import { inBounds } from "../lib/util";

/** TDX city codes with rough bounding boxes, used to pick which city feed to load. */
export interface City {
  code: string;
  name: string;
  bounds: Bounds;
}

const b = (south: number, north: number, west: number, east: number): Bounds => ({ south, north, west, east });

export const CITIES: City[] = [
  { code: "Taipei", name: "臺北市", bounds: b(24.96, 25.21, 121.45, 121.67) },
  { code: "NewTaipei", name: "新北市", bounds: b(24.67, 25.3, 121.28, 122.01) },
  { code: "Keelung", name: "基隆市", bounds: b(25.05, 25.2, 121.62, 121.81) },
  { code: "Taoyuan", name: "桃園市", bounds: b(24.59, 25.12, 120.97, 121.47) },
  { code: "Hsinchu", name: "新竹市", bounds: b(24.72, 24.86, 120.88, 121.03) },
  { code: "HsinchuCounty", name: "新竹縣", bounds: b(24.43, 24.95, 120.9, 121.42) },
  { code: "MiaoliCounty", name: "苗栗縣", bounds: b(24.27, 24.76, 120.61, 121.27) },
  { code: "Taichung", name: "臺中市", bounds: b(23.99, 24.45, 120.46, 121.45) },
  { code: "ChanghuaCounty", name: "彰化縣", bounds: b(23.78, 24.21, 120.24, 120.7) },
  { code: "NantouCounty", name: "南投縣", bounds: b(23.44, 24.25, 120.62, 121.35) },
  { code: "YunlinCounty", name: "雲林縣", bounds: b(23.5, 23.83, 120.13, 120.73) },
  { code: "Chiayi", name: "嘉義市", bounds: b(23.44, 23.52, 120.39, 120.5) },
  { code: "ChiayiCounty", name: "嘉義縣", bounds: b(23.15, 23.65, 120.09, 120.85) },
  { code: "Tainan", name: "臺南市", bounds: b(22.88, 23.42, 120.03, 120.66) },
  { code: "Kaohsiung", name: "高雄市", bounds: b(22.47, 23.47, 120.17, 121.05) },
  { code: "PingtungCounty", name: "屏東縣", bounds: b(21.89, 22.89, 120.39, 120.91) },
  { code: "YilanCounty", name: "宜蘭縣", bounds: b(24.31, 24.99, 121.31, 121.98) },
  { code: "HualienCounty", name: "花蓮縣", bounds: b(23.1, 24.38, 121.19, 121.75) },
  { code: "TaitungCounty", name: "臺東縣", bounds: b(21.9, 23.45, 120.73, 121.6) },
  { code: "PenghuCounty", name: "澎湖縣", bounds: b(23.15, 23.81, 119.31, 119.73) },
  { code: "KinmenCounty", name: "金門縣", bounds: b(24.35, 24.55, 118.13, 118.52) },
  { code: "LienchiangCounty", name: "連江縣", bounds: b(25.93, 26.4, 119.85, 120.52) },
];

const area = (x: Bounds) => (x.north - x.south) * (x.east - x.west);

/** Cities whose box contains the point, most specific first (boxes overlap near borders). */
export function citiesAt(p: Point): City[] {
  return CITIES.filter((c) => inBounds(p, c.bounds)).sort((a, z) => area(a.bounds) - area(z.bounds));
}

export const TAIWAN: Bounds = b(21.8, 26.5, 118.0, 122.2);

export function inTaiwan(p: Point): boolean {
  return citiesAt(p).length > 0;
}
