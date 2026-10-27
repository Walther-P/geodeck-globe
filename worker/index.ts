import { MAX_RELAY_BYTES, isSameOriginRequest, matchRelayRule, redirectWithinRule, relayCacheKeys, withSiteKey, type SiteKeyName } from "./relay";
import { cameraContentType, cameraTarget } from "./camera";
import { allowedHop, coordinatesFromHtml, hasCoordinates, resolvableStart } from "./resolve";

type Env = { ASSETS: Fetcher } & Partial<Record<SiteKeyName, string>>;

const FORWARDED_REQUEST_HEADERS = ["accept", "authorization", "content-type"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "last-modified", "etag", "retry-after"];

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    // The marker tells the page this came from the relay (see src/lib/net.ts).
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-relay-cache": "ERROR" },
  });
}

async function relay(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const self = new URL(request.url);
  if (!isSameOriginRequest(request.headers, self.origin)) return fail(403, "relay is for this site only");
  const match = matchRelayRule(self.searchParams.get("u"), request.method);
  if (!match) return fail(400, "upstream not allowed");
  const { url, rule } = match;
  const upstreamRequest = withSiteKey(url, rule, env);
  if (!upstreamRequest) return fail(501, "this source is not set up on this site");

  const cache = (caches as unknown as { default: Cache }).default;
  const keys = relayCacheKeys(url, request.headers.get("accept"));
  const cacheKey = new Request(keys.fresh, { method: "GET" });
  // A longer-lived copy of the last good answer, for when the upstream refuses us.
  const staleKey = new Request(keys.stale, { method: "GET" });
  const fromStale = async (): Promise<Response | null> => {
    if (!rule.staleTtl || rule.keyed) return null;
    const hit = await cache.match(staleKey);
    if (!hit) return null;
    const response = new Response(hit.body, hit);
    response.headers.set("x-relay-cache", "STALE");
    response.headers.set("cache-control", "no-store");
    return response;
  };
  if (rule.ttl > 0 && !rule.keyed) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const response = new Response(hit.body, hit);
      response.headers.set("x-relay-cache", "HIT");
      return response;
    }
  }

  const headers = new Headers({ "user-agent": "Baiyan/0.2 (+https://github.com/Walther-P/geodeck-globe)" });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value && (rule.keyed || name !== "authorization")) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(upstreamRequest.headers)) headers.set(name, value);

  let upstream: Response;
  try {
    const body = rule.method === "POST" ? await request.arrayBuffer() : undefined;
    const send = (target: URL) => fetch(target.toString(), { method: rule.method, headers, body, signal: AbortSignal.timeout(20000), redirect: "manual" });
    upstream = await send(upstreamRequest.url);
    const moved = upstream.status >= 300 && upstream.status < 400 ? redirectWithinRule(upstreamRequest.url, upstream.headers.get("location"), rule) : null;
    if (moved) {
      await upstream.body?.cancel();
      upstream = await send(moved);
    }
  } catch {
    return (await fromStale()) ?? fail(504, "upstream timeout");
  }
  const length = Number(upstream.headers.get("content-length") || 0);
  if (length > MAX_RELAY_BYTES) return fail(502, "upstream response too large");
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_RELAY_BYTES) return fail(502, "upstream response too large");

  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (rule.contentType && upstream.status === 200) out.set("content-type", rule.contentType);
  if (upstream.status !== 200) {
    const stale = await fromStale();
    if (stale) return stale;
  }
  const shareable = upstream.status === 200 && rule.ttl > 0 && !rule.keyed;
  out.set("cache-control", shareable ? `public, max-age=${rule.ttl}` : "no-store");
  out.set("x-relay-cache", "MISS");
  const response = new Response(body, { status: upstream.status, headers: out });
  if (shareable) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    if (rule.staleTtl) {
      const keep = new Headers(out);
      keep.set("cache-control", `public, max-age=${rule.staleTtl}`);
      ctx.waitUntil(cache.put(staleKey, new Response(body.slice(0), { status: 200, headers: keep })));
    }
  }
  return response;
}

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "accept-language": "zh-TW,zh;q=0.9,en;q=0.6",
  accept: "text/html,application/xhtml+xml",
};

function json(data: unknown, ttl = 0): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": ttl ? `public, max-age=${ttl}` : "no-store",
      "x-relay-cache": "MISS",
    },
  });
}

/** Follows a Google Maps share link to the place it names (see worker/resolve.ts). */
async function resolveLink(request: Request, ctx: ExecutionContext): Promise<Response> {
  const self = new URL(request.url);
  if (!isSameOriginRequest(request.headers, self.origin)) return fail(403, "for this site only");
  const start = resolvableStart(self.searchParams.get("u"));
  if (!start) return fail(400, "not a Google Maps link");
  if (hasCoordinates(start.href)) return json({ url: start.href });
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://resolve.invalid/?u=${encodeURIComponent(start.href)}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  let url = start;
  for (let hop = 0; hop < 6; hop++) {
    let r: Response;
    try {
      r = await fetch(url.href, { redirect: "manual", headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000) });
    } catch {
      return fail(504, "Google did not answer");
    }
    const location = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && location) {
      const next = new URL(location, url);
      // Consent interstitials wrap the real destination in ?continue=.
      const wrapped = next.hostname === "consent.google.com" ? next.searchParams.get("continue") : null;
      const target = wrapped ? new URL(wrapped) : next;
      if (!allowedHop(target)) return fail(400, "link leaves Google Maps");
      url = target;
      await r.body?.cancel();
      if (hasCoordinates(url.href)) break;
      continue;
    }
    // Google often refuses page reads from shared Cloudflare IPs (429); the
    // final URL still carries the place name, so hand that back.
    if (!r.ok) {
      await r.body?.cancel();
      return json({ url: url.href, error: `Google answered ${r.status}` });
    }
    if (hasCoordinates(url.href)) {
      await r.body?.cancel();
      break;
    }
    const html = (await r.text()).slice(0, 900_000);
    const found = coordinatesFromHtml(html);
    const out = json({ url: url.href, ...(found ?? {}) }, found ? 86400 : 0);
    if (found) ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  }
  const out = json({ url: url.href }, 86400);
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

/** Streams an http-only government camera feed to our https page. */
async function cameraProxy(request: Request): Promise<Response> {
  const self = new URL(request.url);
  if (!isSameOriginRequest(request.headers, self.origin)) return fail(403, "for this site only");
  const target = cameraTarget(self.searchParams.get("u"));
  if (!target) return fail(400, "not a government camera");
  // Give up if the camera doesn't answer quickly; once it does, let the
  // stream run for as long as the viewer keeps the card open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let upstream: Response;
  try {
    upstream = await fetch(target.href, { headers: { "user-agent": BROWSER_HEADERS["user-agent"] }, signal: controller.signal });
  } catch {
    return fail(504, "camera did not answer");
  } finally {
    clearTimeout(timer);
  }
  const type = upstream.headers.get("content-type");
  if (!upstream.ok || !cameraContentType(type)) {
    await upstream.body?.cancel();
    return fail(502, "camera sent no image");
  }
  return new Response(upstream.body, { headers: { "content-type": type!, "cache-control": "no-store", "x-relay-cache": "MISS" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/relay") return relay(request, env, ctx);
    if (url.pathname === "/api/resolve") return resolveLink(request, ctx);
    if (url.pathname === "/api/cam") return cameraProxy(request);
    if (url.pathname.startsWith("/api/")) return fail(404, "not found");
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
