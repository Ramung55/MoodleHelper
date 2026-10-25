import { z } from "zod";

/**
 * Boundary for the future Chrome extension. The extension owns authenticated Moodle collection;
 * the website only exchanges validated messages with it. No credentials ever cross this boundary.
 */
export const APPROVED_ORIGINS = [
  "https://id-preview--5c234d24-d1b3-462b-ab27-270a5a21b713.lovable.app",
  "http://localhost:8080",
];

export const ExtensionHello = z.object({
  source: z.literal("moodle-helper-extension"),
  type: z.literal("hello"),
  version: z.string(),
});

export function isApprovedOrigin(origin: string): boolean {
  return APPROVED_ORIGINS.includes(origin);
}

/** Accept a message only from our own window/origin and only if it matches the schema. */
export function parseExtensionMessage(e: Pick<MessageEvent, "origin" | "data">) {
  if (!isApprovedOrigin(e.origin)) return null;
  const r = ExtensionHello.safeParse(e.data);
  return r.success ? r.data : null;
}

/** Ping the extension's content script; resolves false after the timeout. */
export function detectExtension(timeoutMs = 800): Promise<boolean> {
  if (typeof window === "undefined" || !isApprovedOrigin(window.location.origin)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      if (parseExtensionMessage(e)) {
        cleanup();
        resolve(true);
      }
    };
    const cleanup = () => {
      window.removeEventListener("message", onMsg);
      clearTimeout(t);
    };
    const t = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ source: "moodle-helper-web", type: "ping" }, window.location.origin);
  });
}
