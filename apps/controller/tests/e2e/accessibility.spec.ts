/**
 * axe (WCAG 2.2 AA plus best practice) on every page the dashboard links to, in light, dark and at
 * phone width, and on the signed-out pages; then the keyboard contract of dialogs and focus rings.
 * One row of each list is seeded so table headers are checked too, and deleted again afterwards.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForHydration } from '../helpers/hydration';
import { ensureL4ProxyHost } from '../helpers/l4-proxy-api';
import { createAccessList, createProxyHost } from '../helpers/proxy-api';

const ADMIN_STATE = resolve(dirname(fileURLToPath(import.meta.url)), '../.auth/admin.json');
const API = 'http://localhost:3000/api/v1';
const ORIGIN = { Origin: 'http://localhost:3000' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const SEEDED = { host: 'A11y Host', list: 'A11y List', l4: 'A11y TCP' };
const SIGNED_OUT = ['/login', '/login/forgot-password', '/login/reset-password?token=x'];

test.describe.configure({ mode: 'serial' });

async function settle(page: Page, path: string) {
  await page.goto(path);
  await waitForHydration(page);
  await page.waitForLoadState('networkidle');
}

/** One line per failing node, so a report names every element to fix. */
async function axe(page: Page, rules?: string[]): Promise<string[]> {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (rules) builder = builder.withRules(rules);
  const { violations } = await builder.analyze();
  const failures: string[] = [];
  for (const violation of violations) {
    for (const node of violation.nodes) {
      const target = node.target.join(' ');
      // WCAG exempts inactive controls from contrast; axe reads a disabled field's suffix as text.
      if (violation.id === 'color-contrast') {
        const inactive = await page.evaluate(
          (selector) =>
            !!document.querySelector(selector)?.parentElement?.querySelector('input:disabled'),
          target,
        );
        if (inactive) continue;
      }
      const detail = node.failureSummary?.split(/\r?\n/)[1]?.trim();
      failures.push(
        `${violation.id} (${violation.help}): ${target}${detail ? ` - ${detail}` : ''}`,
      );
    }
  }
  return failures;
}

/** Every dashboard page an admin can reach by following links, settings sections included. */
async function crawl(page: Page): Promise<string[]> {
  const seen = new Set<string>();
  const queue = ['/', '/settings', '/more'];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    await settle(page, path);
    const hrefs = await page.$$eval('a[href^="/"]', (links) =>
      links.map((a) => a.getAttribute('href')!),
    );
    for (const href of hrefs) {
      const clean = href.split(/[?#]/)[0];
      if (!/^\/(api|logout|portal|login|setup)/.test(clean) && !seen.has(clean)) queue.push(clean);
    }
  }
  return [...seen];
}

async function adminPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ storageState: ADMIN_STATE })).newPage();
}

let pages: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const page = await adminPage(browser);
  await createProxyHost(page, {
    name: SEEDED.host,
    domain: 'a11y.test',
    upstream: 'echo-server:8080',
  });
  await createAccessList(page, SEEDED.list, [{ username: 'alice', password: 'A11yPassword2026!' }]);
  await ensureL4ProxyHost(page, {
    name: SEEDED.l4,
    protocol: 'tcp',
    listenAddress: ':15433',
    upstream: 'tcp-echo:9000',
  });
  pages = await crawl(page);
  await page.context().close();
});

test.afterAll(async ({ browser }) => {
  const page = await adminPage(browser);
  for (const [collection, name] of [
    ['proxy-hosts', SEEDED.host],
    ['access-lists', SEEDED.list],
    ['l4-proxy-hosts', SEEDED.l4],
  ]) {
    const rows = (await (await page.request.get(`${API}/${collection}`)).json()) as {
      id: number;
      name: string;
    }[];
    for (const row of rows.filter((r) => r.name === name))
      await page.request.delete(`${API}/${collection}/${row.id}`, { headers: ORIGIN });
  }
  await page.context().close();
});

test('every page passes axe in light and dark, with one h1, one main and its own title', async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const failures: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of pages) {
      await settle(page, path);
      if (scheme === 'dark') {
        failures.push(...(await axe(page, ['color-contrast'])).map((f) => `dark ${path}: ${f}`));
        continue;
      }
      failures.push(...(await axe(page)).map((f) => `${path}: ${f}`));
      const shape = await page.evaluate(() => ({
        h1: document.querySelectorAll('h1').length,
        main: document.querySelectorAll('main, [role=main]').length,
        title: document.title,
      }));
      if (shape.h1 !== 1) failures.push(`${path}: ${shape.h1} h1 elements`);
      if (shape.main !== 1) failures.push(`${path}: ${shape.main} main landmarks`);
      if (!shape.title.includes(' · ')) failures.push(`${path}: generic title "${shape.title}"`);
    }
  }
  expect(failures).toEqual([]);
});

test('every page passes axe at phone width', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const failures: string[] = [];
  for (const path of pages) {
    await settle(page, path);
    failures.push(...(await axe(page)).map((f) => `${path}: ${f}`));
  }
  expect(failures).toEqual([]);
});

test('signed-out pages pass axe in light and dark', async ({ browser }) => {
  const failures: string[] = [];
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      colorScheme,
    });
    const page = await context.newPage();
    for (const path of SIGNED_OUT) {
      await settle(page, path);
      failures.push(...(await axe(page)).map((f) => `${colorScheme} ${path}: ${f}`));
    }
    await context.close();
  }
  expect(failures).toEqual([]);
});

test('a failed sign-in is announced', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await settle(page, '/login');
  await page.getByRole('textbox', { name: /username/i }).fill('nobody');
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.getByRole('textbox', { name: /password/i }).fill('wrong-password');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible();
  await context.close();
});

for (const [path, trigger] of [
  ['/proxy-hosts', 'New'],
  ['/l4-proxy-hosts', 'New'],
  ['/access-lists', 'New'],
  ['/groups', 'New'],
  ['/users', 'New'],
  ['/settings/authentication', 'Add Provider'],
] as const) {
  test(`the dialog behind "${trigger}" on ${path} is named, closes on Escape and returns focus`, async ({
    page,
  }) => {
    await settle(page, path);
    const button = page
      .getByRole('button', { name: trigger, exact: true })
      .filter({ visible: true })
      .first();
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate(
        (d) => !!d.getAttribute('aria-labelledby') || !!d.getAttribute('aria-label'),
      ),
    ).toBe(true);
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    // Mid fade-in, every colour reads lighter than it renders.
    await dialog.evaluate((d) =>
      Promise.all(d.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    expect(await axe(page)).toEqual([]);
    // A hovered tooltip takes the first Escape, as it must; keep the pointer off the dialog.
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });
}

test('the first Tab reaches the skip link, and every focus stop shows a ring', async ({ page }) => {
  const failures: string[] = [];
  for (const path of ['/', '/proxy-hosts', '/settings', '/profile']) {
    await settle(page, path);
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (first !== 'Skip to content') failures.push(`${path}: first stop is "${first}"`);
    for (let i = 0; i < 30; i++) {
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        // Astryx rings a text field's frame (:focus-within), not the input itself.
        for (
          let node: Element | null = el, depth = 0;
          node && depth < 4;
          node = node.parentElement, depth++
        ) {
          const s = getComputedStyle(node);
          if (
            (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
            s.boxShadow !== 'none'
          )
            return null;
        }
        return el.outerHTML.slice(0, 160);
      });
      if (stop) failures.push(`${path}: no focus ring on ${stop}`);
      await page.keyboard.press('Tab');
    }
  }
  expect(failures).toEqual([]);
});
