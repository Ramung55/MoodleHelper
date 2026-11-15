import { errors, type ErrorCode } from "../../../shared/src/bridge";

/**
 * Where the dashboard reaches the local backend (#49).
 * Development uses same-origin "/api" through the Vite proxy. The approved GitHub Pages
 * build talks to the loopback backend directly; the backend allows only that origin by CORS.
 */
export const PAGES_ORIGIN = "https://ramung55.github.io";
export const PAGES_BASE_PATH = "/MoodleHelper/";
export const LOCAL_BACKEND = "http://127.0.0.1:8000";

export function apiBase(origin: string | undefined = globalThis.location?.origin): string {
  return origin === PAGES_ORIGIN ? LOCAL_BACKEND : "";
}

/**
 * #138: the hosted dashboard is served same-origin from `https://<machine>.<tailnet>.ts.net` (same shape as
 * extension/build.ts backendOrigin). The real name is never committed, so the page approves its own origin by
 * shape; the hosted extension's bridge and relay still enforce their exact allowlist.
 */
export const isTailnetOrigin = (origin: string | undefined = globalThis.location?.origin) =>
  !!origin && /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/.test(origin);

/** Bridge error text as the frontend shows it: BACKEND_UNAVAILABLE names Tailscale on the tailnet origin. */
export const bridgeMessage = (code: ErrorCode, origin?: string) =>
  code === "BACKEND_UNAVAILABLE" && isTailnetOrigin(origin)
    ? "Connect this device to Tailscale, then reconnect."
    : errors[code];
