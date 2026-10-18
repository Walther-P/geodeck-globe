// Every network read goes through here so errors read the same everywhere and
// a feed that blocks browsers (no CORS) can go through our same-origin relay
// (worker/relay.ts). The relay exists only on the deployed Worker.

export type Route = "direct" | "relay" | "direct-then-relay";

export class FeedError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  route?: Route;
  timeout?: number;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/** null = not tried yet; false = this deployment has no relay (e.g. `vite dev`). */
let relayPresent: boolean | null = null;
/** Hosts that refused a direct browser read this session; go straight to the relay. */
const blockedHosts = new Set<string>();

export function relayUrl(target: string): string {
  return `${location.origin}/relay?u=${encodeURIComponent(target)}`;
}

export function statusText(status: number): string {
  if (status === 401 || status === 403) return "金鑰無效、已過期或沒有權限";
  if (status === 404) return "來源找不到這筆資料";
  if (status === 429) return "來源暫時限制使用次數，請稍後再試";
  if (status >= 500) return "來源暫時無法服務";
  return `來源回應錯誤（${status}）`;
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function describe(e: unknown): FeedError {
  if (e instanceof FeedError) return e;
  if (isTimeout(e)) return new FeedError("連線逾時");
  // fetch() rejects with TypeError for offline, DNS and CORS refusals alike.
  return new FeedError(navigator.onLine === false ? "目前離線" : "連線失敗，或來源不允許瀏覽器直接讀取");
}

async function send(url: string, opts: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 15000);
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

function checked(r: Response): Response {
  if (!r.ok) throw new FeedError(statusText(r.status), r.status);
  return r;
}

/** Returns null when this deployment has no relay. */
async function viaRelay(url: string, opts: FetchOptions): Promise<Response | null> {
  if (relayPresent === false) return null;
  const r = await send(relayUrl(url), opts);
  // Our Worker always marks relayed responses; anything else is the SPA page.
  if (!r.headers.has("x-relay-cache")) {
    relayPresent = false;
    return null;
  }
  relayPresent = true;
  return checked(r);
}

export async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  const route = opts.route ?? "direct";
  const host = new URL(url).hostname;
  try {
    if (route === "relay" || (route === "direct-then-relay" && blockedHosts.has(host) && relayPresent !== false))
      return (await viaRelay(url, opts)) ?? checked(await send(url, opts));
    try {
      return checked(await send(url, opts));
    } catch (e) {
      const blocked = !(e instanceof FeedError) && !isTimeout(e) && !opts.signal?.aborted;
      if (route !== "direct-then-relay" || !blocked) throw e;
      blockedHosts.add(host);
      const relayed = await viaRelay(url, opts);
      if (!relayed) throw e;
      return relayed;
    }
  } catch (e) {
    throw describe(e);
  }
}

export async function getJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const r = await request(url, opts);
  try {
    return (await r.json()) as T;
  } catch {
    throw new FeedError("來源回傳的格式無法讀取");
  }
}

export async function getText(url: string, opts: FetchOptions = {}): Promise<string> {
  return (await request(url, opts)).text();
}
