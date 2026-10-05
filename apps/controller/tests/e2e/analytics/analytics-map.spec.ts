import { test, expect, type Page } from '@playwright/test';

/**
 * maplibre-gl v6 resolves its worker from `import.meta.url`, which the bundler cannot follow, so
 * the app imports it as `?worker&url` and calls setWorkerUrl(); otherwise the map is empty ocean.
 */

const MAP_CANVAS = 'canvas.maplibregl-canvas';

async function gotoAnalyticsMap(page: Page) {
  await page.goto('/analytics');
  await expect(page.getByText('Traffic by Country')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(MAP_CANVAS)).toBeVisible({ timeout: 15_000 });
}

test.describe('Analytics world map', () => {
  test('maplibre worker is served as one self-contained chunk', async ({ page }) => {
    const mapRequests: { url: string; status: number }[] = [];
    page.on('response', (res) => {
      const url = new URL(res.url()).pathname;
      if (url.includes('maplibre')) mapRequests.push({ url, status: res.status() });
    });

    await gotoAnalyticsMap(page);
    // Content-hashed name in a directory the bundler chooses, so match the stem.
    await expect
      .poll(() => mapRequests.map((r) => r.url), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('maplibre-gl-worker-')]));

    // A separate request for the shared sibling means the worker entry was emitted alone, and its
    // relative import 404s.
    expect(
      mapRequests.filter((r) => r.url.includes('maplibre-gl-shared')),
      'maplibre-gl-shared should be bundled into the worker chunk, not fetched separately',
    ).toEqual([]);

    const failed = mapRequests.filter((r) => r.status >= 400);
    expect(failed, `maplibre assets failed to load: ${JSON.stringify(failed)}`).toEqual([]);
  });

  test('map loads without CSP violations or worker errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await gotoAnalyticsMap(page);
    await page.waitForTimeout(3_000); // let the worker spin up and the source parse

    const mapErrors = errors.filter((e) => /worker|content security policy|maplibre/i.test(e));
    expect(mapErrors, `map errors in console: ${JSON.stringify(mapErrors)}`).toEqual([]);
  });

  test('map renders country geometry that responds to hover', async ({ page }) => {
    await gotoAnalyticsMap(page);

    // The container is `overflow: hidden`: collapsed to zero height it clips the canvas while the
    // map still reports features, so check height first rather than fail as "no geometry".
    const mapContainer = page.locator('.maplibregl-map');
    await expect
      .poll(async () => Math.round((await mapContainer.boundingBox())?.height ?? 0), {
        timeout: 10_000,
        message: 'the MapLibre container collapsed to zero height - the canvas is clipped away',
      })
      .toBeGreaterThan(100);

    const canvas = page.locator(MAP_CANVAS);
    // The map sits below the fold, and the mouse cannot reach outside the viewport.
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // The canvas is visible well before any geometry exists.
    await page.waitForTimeout(3_000);

    // A grid, not hand-picked offsets: the projection depends on how maplibre fits the bounds.
    const targets: [number, number][] = [];
    for (const fy of [0.3, 0.4, 0.5, 0.62, 0.72]) {
      for (const fx of [0.2, 0.3, 0.5, 0.55, 0.72, 0.85]) {
        targets.push([fx, fy]);
      }
    }

    const popup = page.locator('.wm-popup');
    let popupText: string | null = null;
    for (const [fx, fy] of targets) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      // Hover is re-evaluated only on mousemove, and moving to the current position fires none.
      await page.mouse.move(x - 2, y - 2);
      await page.mouse.move(x, y);
      try {
        await expect(popup).toBeVisible({ timeout: 1_000 });
        // Bounded: the second move can leave a coastline for sea and close the popup, and an
        // unbounded read would wait out the whole test.
        popupText = await popup.innerText({ timeout: 1_000 });
        break;
      } catch {
        // Miss - try the next point.
      }
    }

    expect(
      popupText,
      `no country popup appeared over any of ${targets.length} points - the map rendered no country geometry`,
    ).not.toBeNull();
    expect(popupText).toContain('Requests');
  });
});
