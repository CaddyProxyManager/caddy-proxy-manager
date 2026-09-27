/**
 * Every demo hydrates without throwing. The build's server render misses a stale shim or server
 * code leaking into the bundle, which leave dead markup nobody but a reader notices.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

/** As paths under the site's base. */
function pagesWithDemos(dir = dist): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pagesWithDemos(path);
    if (entry.name !== "index.html" || !readFileSync(path, "utf8").includes("<astro-island")) {
      return [];
    }
    return [relative(dist, dir).replaceAll("\\", "/")];
  });
}

const pages = pagesWithDemos();

test("the build has demos to check", () => {
  expect(pages.length).toBeGreaterThan(0);
});

for (const page of pages) {
  test(`demos on /${page} hydrate cleanly`, async ({ page: browser }) => {
    const errors: string[] = [];
    browser.on("pageerror", (error) => errors.push(error.message));
    // Chromium logs a failed request without its URL, so take it from the response.
    browser.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        errors.push(message.text());
      }
    });
    browser.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });

    await browser.goto(page ? `${page}/` : "./");
    const islands = browser.locator("astro-island");
    const count = await islands.count();
    expect(count).toBeGreaterThan(0);

    // Most demos are client:visible; Astro drops `ssr` once an island hydrates.
    for (let index = 0; index < count; index++) {
      const island = islands.nth(index);
      await island.scrollIntoViewIfNeeded();
      await expect(island).not.toHaveAttribute("ssr", { timeout: 15_000 });
    }
    // A fetch-on-mount failure lands after hydration; without this the check races it.
    await browser.waitForLoadState("networkidle");

    expect(errors).toEqual([]);
  });
}
