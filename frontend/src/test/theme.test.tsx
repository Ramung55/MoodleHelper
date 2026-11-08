import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { THEME_BOOTSTRAP, THEME_KEY, ThemeController, ThemeSettings } from "@/components/mh/Theme";
let dark = false;
let change: (() => void) | undefined;
beforeEach(() => {
  dark = false;
  change = undefined;
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, cb: () => void) => {
        change = cb;
      },
      removeEventListener: () => {},
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
it("applies system theme before rendering, including invalid and inaccessible storage", () => {
  dark = true;
  new Function(THEME_BOOTSTRAP)();
  expect(document.documentElement).toHaveClass("dark");
  localStorage.setItem(THEME_KEY, "blue");
  new Function(THEME_BOOTSTRAP)();
  expect(document.documentElement).toHaveClass("dark");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => new Function(THEME_BOOTSTRAP)()).not.toThrow();
  expect(document.documentElement).toHaveClass("dark");
});
it("follows OS changes in System mode and persists explicit overrides", () => {
  render(
    <>
      <ThemeController />
      <ThemeSettings />
    </>,
  );
  expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  dark = true;
  change?.();
  expect(document.documentElement).toHaveClass("dark");
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(document.documentElement).not.toHaveClass("dark");
  expect(localStorage.getItem(THEME_KEY)).toBe("light");
  dark = false;
  change?.();
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement).toHaveClass("dark");
  cleanup();
  render(
    <>
      <ThemeController />
      <ThemeSettings />
    </>,
  );
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "System" }));
  expect(localStorage.getItem(THEME_KEY)).toBeNull();
  expect(document.documentElement).not.toHaveClass("dark");
});
it("falls back to System when storage rejects writes", () => {
  dark = true;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  render(
    <>
      <ThemeController />
      <ThemeSettings />
    </>,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  expect(document.documentElement).toHaveClass("dark");
});
