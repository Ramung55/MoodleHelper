export type ShellState = "loading" | "empty" | "error";

/** Explicit build-time gate; production never selects simulated application state. */
export function shellPreview(value: unknown, development = import.meta.env.DEV): ShellState | undefined {
  return development && (value === "loading" || value === "empty" || value === "error") ? value : undefined;
}

export function shellSearch(search: Record<string, unknown>): { shellState?: ShellState } {
  const shellState = shellPreview(search["shellState"]);
  return shellState ? { shellState } : {};
}
