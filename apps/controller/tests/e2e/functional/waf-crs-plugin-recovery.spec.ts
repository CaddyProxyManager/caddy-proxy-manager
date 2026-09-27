/**
 * Functional: a CRS plugin Coraza will not compile makes Caddy refuse every config, so the
 * controller must find and drop it. Seeded into the database, since installing needs GitHub.
 */
import { test, expect } from '@playwright/test';
import { createProxyHost } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';
import { waitForHydration } from '../../helpers/hydration';
import { clearSettingRow, runSeedScript, setSettingRow } from '../../helpers/seed';

const DOMAIN = 'func-waf-plugin-recovery.test';
const TRIGGER_DOMAIN = 'func-waf-plugin-recovery-trigger.test';

function globalWaf(pluginIds: number[]) {
  return {
    enabled: true,
    mode: 'On',
    load_owasp_crs: true,
    custom_directives: '',
    excluded_rule_ids: [],
    plugin_ids: pluginIds,
  };
}

/** Passes every static check, but Go's regexp refuses the reversed range and names no rule id. */
const BROKEN_RULE = 'SecRule ARGS "@rx [z-a]" "id:9599100,phase:1,pass,nolog"';
const WORKING_RULE = 'SecRule ARGS "@rx x" "id:9598100,phase:1,pass,nolog"';

function seedPlugin(name: string, start: number, before: string): number {
  const out = runSeedScript(`
    const now = new Date().toISOString();
    const [row] = await sql\`
      INSERT INTO crs_plugins
        (name, repository, version, description, "ruleIdStart", "ruleIdEnd", "configRules",
         "beforeRules", "afterRules", "fileNames", "createdAt", "updatedAt")
      VALUES (\${${JSON.stringify(name)}}, \${${JSON.stringify(`https://github.com/e2e/${name}`)}},
        'v1', null, \${${start}}, \${${start + 999}}, '', \${${JSON.stringify(before)}}, '', '[]',
        \${now}, \${now})
      RETURNING id\`;
    console.log(row.id);
    await sql.close();
  `);
  return Number(out.trim().split('\n').at(-1));
}

function readSetting(key: string): unknown {
  const out = runSeedScript(`
    const [row] = await sql\`SELECT value FROM settings WHERE key = \${${JSON.stringify(key)}}\`;
    console.log(row ? row.value : "null");
    await sql.close();
  `);
  return JSON.parse(out.trim().split('\n').at(-1) ?? 'null');
}

let brokenId = 0;
let workingId = 0;
let savedWaf: unknown = null;

test.describe
  .serial('WAF CRS plugin that Coraza refuses', () => {
    test.beforeAll(() => {
      savedWaf = readSetting('waf');
      workingId = seedPlugin('e2e-working', 9598000, WORKING_RULE);
      brokenId = seedPlugin('e2e-broken', 9599000, BROKEN_RULE);
      setSettingRow('waf', globalWaf([]));
    });

    test.afterAll(() => {
      if (savedWaf) setSettingRow('waf', savedWaf);
      else clearSettingRow('waf');
      clearSettingRow('crs_plugin_quarantine');
      runSeedScript(`
        await sql\`DELETE FROM crs_plugins WHERE name IN ('e2e-working', 'e2e-broken')\`;
        await sql.close();
      `);
    });

    test('the config still loads: the host is served', async ({ page }) => {
      // Saved before the global selects the plugins, or the save-time dry run would refuse it.
      await createProxyHost(page, {
        name: 'Functional WAF Plugin Recovery Test',
        domain: DOMAIN,
        upstream: 'echo-server:8080',
        enableWaf: true,
        wafMode: 'merge',
      });
      setSettingRow('waf', globalWaf([brokenId, workingId]));
      // Any save applies the whole config; this host has its WAF off, so nothing is dry-run.
      await createProxyHost(page, {
        name: 'Functional WAF Plugin Recovery Trigger',
        domain: TRIGGER_DOMAIN,
        upstream: 'echo-server:8080',
      });
      await waitForRoute(DOMAIN);
      const res = await httpGet(DOMAIN, '/');
      expect(res.status).toBe(200);
    });

    test('only the plugin Caddy refused is switched off', () => {
      const quarantine = readSetting('crs_plugin_quarantine') as Record<string, unknown> | null;
      expect(Object.keys(quarantine ?? {}).map(Number)).toEqual([brokenId]);
    });

    test('the plugins tab marks it disabled', async ({ page }) => {
      await page.goto('/waf');
      await waitForHydration(page);
      await page.getByRole('button', { name: 'Plugins', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Plugins', level: 2 })).toBeVisible();
      const broken = page.getByRole('row').filter({ hasText: 'e2e-broken' });
      await expect(broken.getByText('Disabled', { exact: true })).toBeVisible();
      const working = page.getByRole('row').filter({ hasText: 'e2e-working' });
      await expect(working.getByText('Disabled', { exact: true })).toHaveCount(0);
    });
  });
