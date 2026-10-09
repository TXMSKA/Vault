import { readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
export const SCHEME = "app";
export const HOST = "vault";
export const ORIGIN = `${SCHEME}://${HOST}`;
/** Everything comes from the app itself: no inline script, no frame, no connection, no form, fonts and styles from the app only. */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
const CAP = 4 * 1024 * 1024;
/**
 * The file an `app://vault/...` address names under `root`, or nothing. The address must already be in its plain form (no query, no
 * fragment, no dots or percent signs to resolve, no other host), every segment a plain file name, and the type one the app serves.
 */
export function resolveRequest(root: string, address: string): { file: string; type: string } | undefined {
  let url: URL;
  try { url = new URL(address); } catch { return undefined; }
  if (url.protocol !== `${SCHEME}:` || url.hostname !== HOST || url.port || url.username || url.password || address !== `${ORIGIN}${url.pathname}`) return undefined;
  const parts = url.pathname === "/" ? ["index.html"] : url.pathname.slice(1).split("/");
  if (parts.length > 4 || !parts.every(part => SEGMENT.test(part))) return undefined;
  const name = parts.at(-1)!, dot = name.lastIndexOf("."), type = dot < 0 ? undefined : TYPES[name.slice(dot).toLowerCase()];
  if (!type) return undefined;
  const file = join(root, ...parts), inside = relative(root, file);
  return inside === "" || inside.startsWith("..") || inside.split(sep).includes("..") ? undefined : { file, type };
}
/** Answers a request for the app's own files; anything else is a 404. A file whose real path leaves `root` (a link) is refused. */
export async function serve(root: string, request: { url: string; method: string }): Promise<Response> {
  const headers = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  const refuse = (status: number) => new Response(null, { status, headers });
  if (request.method !== "GET") return refuse(405);
  const found = resolveRequest(root, request.url); if (!found) return refuse(404);
  try {
    const [base, real] = await Promise.all([realpath(root), realpath(found.file)]), inside = relative(base, real);
    if (inside === "" || inside.startsWith("..") || inside.split(sep).includes("..")) return refuse(404);
    const body = await readFile(real); if (body.length > CAP) return refuse(404);
    return new Response(new Uint8Array(body), { status: 200, headers: { ...headers, "Content-Type": found.type } });
  } catch { return refuse(404); }
}
