/**
 * E2E: with the approval policy on, an administrator's host edit is submitted from the editor's
 * review rather than saved; a second administrator approves it on the Approvals page, and the host
 * changes. The requester cannot approve their own.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ensureTestUser, runSeedScript } from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import { signInWithCredentials } from '../helpers/sign-in';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const ORIGIN = 'http://localhost:3000';
const APPROVER = 'testapprover';
const APPROVER_PASSWORD = 'TestApproverPass2026!';
const HOST = 'Approval E2E';
const RENAMED = 'Approval E2E renamed';

function cleanUp(): void {
  runSeedScript(`
    await sql\`DELETE FROM settings WHERE key = 'change_approval_policy'\`;
    await sql\`DELETE FROM change_requests\`;
    await sql\`DELETE FROM proxy_hosts WHERE name IN (\${${JSON.stringify(HOST)}}, \${${JSON.stringify(RENAMED)}})\`;
    await sql.close();
  `);
}

async function graphql(page: Page, query: string, variables: Record<string, unknown> = {}) {
  const res = await page.request.post('/api/graphql', {
    headers: { Origin: ORIGIN },
    data: { query, variables },
  });
  const body = (await res.json()) as { data?: Record<string, any>; errors?: unknown[] };
  expect(body.errors).toBeUndefined();
  return body.data!;
}

async function hostName(page: Page, id: number): Promise<string> {
  const host = (await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as {
    name: string;
  };
  return host.name;
}

test.describe('Change approvals', () => {
  test.describe.configure({ mode: 'serial' });
  let hostId = 0;

  test.beforeAll(() => {
    cleanUp();
    ensureTestUser(APPROVER, APPROVER_PASSWORD, 'admin');
  });
  test.afterAll(cleanUp);

  test('an edit the policy covers is submitted from the review, not saved', async ({ page }) => {
    const created = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: ORIGIN },
      data: {
        name: HOST,
        domains: ['approval-e2e.local'],
        upstreams: ['localhost:9977'],
        tags: ['approval-e2e'],
      },
    });
    expect(created.ok()).toBe(true);
    hostId = ((await created.json()) as { id: number }).id;
    await graphql(
      page,
      'mutation ($input: JSON!) { setApprovalPolicy(input: $input) { enabled } }',
      {
        // Scoped to this spec's own tag, so nothing else the suite does waits on it.
        input: {
          enabled: true,
          scope: 'tags',
          tags: ['approval-e2e'],
          approverRoles: ['admin'],
          requiredApprovals: 1,
        },
      },
    );

    await page.goto(`/proxy-hosts?edit=${hostId}`);
    await waitForHydration(page);
    const editor = page.getByRole('dialog', { name: 'Edit proxy host' });
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.getByLabel('Name').fill(RENAMED);
    await page.keyboard.press('ControlOrMeta+s');
    const review = page.getByRole('dialog', { name: 'Review changes' });
    await expect(review.getByText('The approval policy holds this change')).toBeVisible({
      timeout: 15_000,
    });
    await review.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(editor).not.toBeVisible({ timeout: 15_000 });
    expect(await hostName(page, hostId)).toBe(HOST);

    await page.goto('/approvals');
    await waitForHydration(page);
    const link = page.getByRole('link', { name: `Edit proxy host ${HOST}` });
    await expect(link).toBeVisible();
    await link.click();
    await waitForHydration(page);
    await expect(page.getByText('This change is waiting for approvers')).toBeVisible();
    // Nobody approves their own change.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByText(`${HOST} to ${RENAMED}`)).toBeVisible();
  });

  test.describe('a second administrator', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    let context: BrowserContext;

    test.beforeAll(async ({ browser }) => {
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('http://localhost:3000/login');
      await waitForHydration(page);
      await signInWithCredentials(page, APPROVER, APPROVER_PASSWORD);
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
      await page.close();
    });

    test.afterAll(async () => {
      await context?.close();
    });

    test('approves it, and the host changes', async () => {
      const page = await context.newPage();
      await page.goto('http://localhost:3000/approvals');
      await waitForHydration(page);
      await page.getByRole('link', { name: `Edit proxy host ${HOST}` }).click();
      await waitForHydration(page);
      await page.getByRole('button', { name: 'Approve' }).click();
      const dialog = page.getByRole('dialog', { name: /Approve change request/ });
      await dialog.getByLabel('Note for the requester').fill('Looks right');
      await dialog.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByText('Approved and applied.')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Looks right')).toBeVisible();
      expect(await hostName(page, hostId)).toBe(RENAMED);
      await page.close();
    });
  });
});
