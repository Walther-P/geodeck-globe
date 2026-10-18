// Each visitor brings their own TDX and CWA keys. Keys live only in this
// browser's localStorage and go straight to the official API (or, only when a
// browser is refused, through our relay, which forwards and never stores them).
// Nothing in this repository ships anyone's key.

import { read, remove, write } from "../lib/store";

export interface Keys {
  tdxId: string;
  tdxSecret: string;
  cwa: string;
  /** Optional Google Maps Platform key for place search (Places API). */
  google: string;
}

const STORAGE = "gdg.keys.v1";
const EMPTY: Keys = { tdxId: "", tdxSecret: "", cwa: "", google: "" };

let listeners: Array<(k: Keys) => void> = [];
let current: Keys = normalizeKeys(read<Partial<Keys>>(STORAGE, {}));

export function normalizeKeys(raw: Partial<Keys> | null | undefined): Keys {
  const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, "") : "");
  return { tdxId: clean(raw?.tdxId), tdxSecret: clean(raw?.tdxSecret), cwa: clean(raw?.cwa), google: clean(raw?.google) };
}

export function keys(): Keys {
  return current;
}

export const hasTdx = () => !!(current.tdxId && current.tdxSecret);
export const hasCwa = () => !!current.cwa;
export const hasGoogle = () => !!current.google;

export function saveKeys(next: Partial<Keys>): boolean {
  current = normalizeKeys({ ...current, ...next });
  const ok = Object.values(current).some(Boolean) ? write(STORAGE, current) : (remove(STORAGE), true);
  for (const fn of listeners) fn(current);
  return ok;
}

export function clearKeys(): void {
  current = { ...EMPTY };
  remove(STORAGE);
  for (const fn of listeners) fn(current);
}

export function onKeysChange(fn: (k: Keys) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

/** Shown in settings so people can tell which key is stored without revealing it. */
export function mask(v: string): string {
  if (!v) return "未設定";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}
