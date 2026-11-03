// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// `bun run build:pages` (#49): a static SPA for https://ramung55.github.io/MoodleHelper/.
// Vite's base sets the router basepath; every route is prerendered so deep links load directly.
const pages = process.env["MOODLE_HELPER_PAGES"] === "1";

export default defineConfig({
  // The default Cloudflare output has no standalone local Node server, and
  // Vite preview looks for dist/server/server.js instead of Nitro's .output.
  // Use the existing Nitro Node entry for local production route verification.
  nitro: pages ? {} : { preset: "node-server" },
  vite: {
    ...(pages ? { base: "/MoodleHelper/" } : {}),
    server: {
      host: "127.0.0.1",
      proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    ...(pages ? { spa: { enabled: true }, prerender: { enabled: true, crawlLinks: true } } : {}),
  },
});
