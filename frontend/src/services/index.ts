import type { MoodleHelperAdapter } from "./adapter";
import { HttpAdapter } from "./http-adapter";

/**
 * Services entry point. The local FastAPI server owns the current dataset.
 * HTTP failures are surfaced to the UI; fixtures are never a fallback.
 */
let instance: MoodleHelperAdapter | null = null;
export function getAdapter(): MoodleHelperAdapter {
  if (!instance) instance = new HttpAdapter();
  return instance;
}

export type { MoodleHelperAdapter } from "./adapter";
