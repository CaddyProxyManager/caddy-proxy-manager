/** public/favicon.svg is a copy of the dashboard's default favicon, which Starlight serves by name. */
import { expect, test } from "bun:test";
import { DEFAULT_FAVICON_SVG } from "@cpm/controller/src/lib/branding/default-favicon";

test("the site's favicon matches the controller's default", async () => {
  const file = await Bun.file(new URL("../../public/favicon.svg", import.meta.url)).text();
  // The copy carries a <title>, which Biome's a11y rules require of a standalone SVG.
  expect(file.trim().replace(/<title>[^<]*<\/title>/, "")).toBe(DEFAULT_FAVICON_SVG);
});
