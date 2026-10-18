// Camera feeds that are http-only would be blocked as mixed content on our
// https page, so the Worker streams them. Government camera hosts only.

export function cameraTarget(raw: string | null): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return /(^|\.)gov\.tw$/.test(u.hostname) ? u : null;
}

/** Still images and MJPEG streams only; anything else is refused. */
export function cameraContentType(type: string | null): boolean {
  return !!type && /^(image\/|multipart\/x-mixed-replace)/i.test(type);
}
