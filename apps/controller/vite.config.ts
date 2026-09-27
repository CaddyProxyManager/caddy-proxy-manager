import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

// Release images pass APP_VERSION (the tag without its v); other builds use package.json.
const { version: pkgVersion } = createRequire(import.meta.url)("./package.json");
const appVersion = String(process.env.APP_VERSION || pkgVersion || "unknown").replace(/^v/, "");

export default defineConfig({
  plugins: [tailwindcss(), vinext()],

  // Inlined, so the rest of package.json stays out of the client bundle.
  define: {
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(appVersion),
  },

  // maplibre-gl's tile worker is `{ type: "module" }` (WorldMapInner.tsx); Vite defaults to iife.
  worker: { format: "es" },

  build: {
    rolldownOptions: {
      // An import that is always undefined is a dead branch the bundler found; fail, not warn.
      onwarn(warning, warn) {
        if (warning.code === "IMPORT_IS_UNDEFINED") throw new Error(warning.message);
        warn(warning);
      },
    },
  },
});
