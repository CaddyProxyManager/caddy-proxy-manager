/**
 * Functional: custom WAF path rule - global WAF on, per-host WAF merging, and a custom SecRule on
 * REQUEST_URI blocking /admin.
 */
import { test, expect } from '@playwright/test';
import { createProxyHost } from '../../helpers/proxy-api';
import { expectStaged } from '../../helpers/staged-settings';
import { httpGet, waitForRoute } from '../../helpers/http';
import { waitForHydration } from '../../helpers/hydration';

const DOMAIN = 'func-waf-custom-path.test';
const ECHO_BODY = 'echo-ok';
const BLOCK_RULE =
  'SecRule REQUEST_URI "@contains /admin" "id:1001,phase:1,deny,status:403,msg:\'Blocked Path\',log"';

test.describe
  .serial('WAF Custom Path Rule', () => {
    test('setup: enable global WAF and create merge-mode host with custom path rule', async ({
      page,
    }) => {
      await page.goto('/waf');
      await waitForHydration(page);
      await page.getByRole('button', { name: /settings/i }).click();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

      // Astryx controls emit no ids; by role and name instead.
      const wafSwitch = page.getByRole('switch', { name: /enable waf globally/i });
      const owaspCheckbox = page.getByRole('switch', { name: /load owasp core rule set/i });

      if (!(await wafSwitch.isChecked())) {
        await wafSwitch.click();
        await expect(wafSwitch).toBeChecked();
      }
      if (!(await owaspCheckbox.isChecked())) {
        await owaspCheckbox.click();
        await expect(owaspCheckbox).toBeChecked();
      }

      // The button never disables, so wait for the staged banner.
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expectStaged(page);

      await createProxyHost(page, {
        name: 'Functional WAF Custom Path Rule Test',
        domain: DOMAIN,
        upstream: 'echo-server:8080',
        enableWaf: true,
        wafMode: 'merge',
        wafCustomDirectives: BLOCK_RULE,
      });
      await waitForRoute(DOMAIN);
    });

    test('non-admin path still passes through', async () => {
      const res = await httpGet(DOMAIN, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain(ECHO_BODY);
    });

    test('REQUEST_URI custom rule blocks /admin', async () => {
      const res = await httpGet(DOMAIN, '/admin');
      expect(res.status).toBe(403);
    });

    test('REQUEST_URI custom rule blocks /admin with query string', async () => {
      const res = await httpGet(DOMAIN, '/admin?via=test');
      expect(res.status).toBe(403);
    });
  });
