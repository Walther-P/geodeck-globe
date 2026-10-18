import { MAX_RELAY_BYTES, isSameOriginRequest, matchRelayRule } from "./relay";

interface Env {
  ASSETS: Fetcher;
}

const FORWARDED_REQUEST_HEADERS = ["accept", "authorization", "content-type"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "last-modified", "etag"];

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    // The marker tells the page this came from the relay (see src/lib/net.ts).
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-relay-cache": "ERROR" },
  });
}

async function relay(request: Request, ctx: ExecutionContext): Promise<Response> {
  const self = new URL(request.url);
  if (!isSameOriginRequest(request.headers, self.origin)) return fail(403, "relay is for this site only");
  const match = matchRelayRule(self.searchParams.get("u"), request.method);
  if (!match) return fail(400, "upstream not allowed");
  const { url, rule } = match;

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (rule.ttl > 0 && !rule.keyed) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const response = new Response(hit.body, hit);
      response.headers.set("x-relay-cache", "HIT");
      return response;
    }
  }

  const headers = new Headers({ "user-agent": "GeoDeckGlobe/0.1 (+https://github.com/Walther-P/geodeck-globe)" });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value && (rule.keyed || name !== "authorization")) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), {
      method: rule.method,
      headers,
      body: rule.method === "POST" ? await request.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(20000),
      redirect: "manual",
    });
  } catch {
    return fail(504, "upstream timeout");
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
  const shareable = upstream.status === 200 && rule.ttl > 0 && !rule.keyed;
  out.set("cache-control", shareable ? `public, max-age=${rule.ttl}` : "no-store");
  out.set("x-relay-cache", "MISS");
  const response = new Response(body, { status: upstream.status, headers: out });
  if (shareable) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/relay") return relay(request, ctx);
    if (url.pathname.startsWith("/api/")) return fail(404, "not found");
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
