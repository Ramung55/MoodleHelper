import { useEffect, useState } from "react";

export const THEME_KEY = "moodle-helper:theme";
type Theme = "system" | "light" | "dark";
const EVENT = "moodle-helper-theme";
const valid = (value: string | null): Theme =>
  value === "light" || value === "dark" ? value : "system";
export function readTheme(): Theme {
  try {
    return valid(window.localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}
function darkSystem() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && darkSystem()),
  );
}
// Executed in the head before styles can paint; keep the storage key and fallback in sync with readTheme.
export const THEME_BOOTSTRAP = `(function(){var v='system';try{var s=localStorage.getItem('moodle-helper:theme');if(s==='dark'||s==='light')v=s}catch(e){}var d=false;try{d=matchMedia('(prefers-color-scheme: dark)').matches}catch(e){}document.documentElement.classList.toggle('dark',v==='dark'||(v==='system'&&d))})()`;

export function ThemeController() {
  useEffect(() => {
    const update = () => applyTheme(readTheme());
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", update);
    } catch {
      /* System preference may be unavailable. */
    }
    window.addEventListener("storage", update);
    window.addEventListener(EVENT, update);
    update();
    return () => {
      media?.removeEventListener("change", update);
      window.removeEventListener("storage", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return null;
}
export function ThemeSettings() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const update = () => setTheme(readTheme());
    update();
    window.addEventListener("storage", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  const select = (next: Theme) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      next = "system";
    }
    setTheme(next);
    applyTheme(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return (
    <fieldset className="rounded-lg border bg-card p-4">
      <legend className="px-1 font-semibold">Appearance</legend>
      <div className="flex flex-wrap gap-4">
        {(["system", "light", "dark"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="appearance"
              checked={theme === value}
              onChange={() => select(value)}
            />
            {value[0]!.toUpperCase() + value.slice(1)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
