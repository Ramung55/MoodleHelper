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
