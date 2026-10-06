/**
 * No docs page scrolls sideways, at a desktop width or a phone's. A demo wider than the content
 * column pushes the whole page, which only shows on a real layout.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

function pages(dir = dist): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === "index.html" ? [relative(dist, dir).replaceAll("\\", "/")] : [];
  });
}

for (const width of [1280, 375]) {
  for (const page of pages()) {
    test(`/${page} fits ${width}px`, async ({ page: browser }) => {
      await browser.setViewportSize({ width, height: 900 });
      await browser.goto(page ? `${page}/` : "./");
      // Hydrated demos measure themselves, so check after every island has rendered for real.
      const islands = browser.locator("astro-island");
      for (let index = 0; index < (await islands.count()); index++) {
        const island = islands.nth(index);
        await island.scrollIntoViewIfNeeded();
        await expect(island).not.toHaveAttribute("ssr", { timeout: 15_000 });
      }
      const overflow = await browser.evaluate(() => {
        const root = document.documentElement;
        const edge = root.clientWidth;
        const culprits = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            const parent = el.parentElement?.getBoundingClientRect();
            return box.width > 0 && box.right > edge + 1 && (parent?.right ?? 0) <= edge + 1;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? ""}`);
        return { by: root.scrollWidth - edge, culprits: culprits.slice(0, 5) };
      });
      expect(overflow).toEqual({ by: 0, culprits: overflow.culprits });
    });
  }
}
