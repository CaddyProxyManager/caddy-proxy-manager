/**
 * E2E: an administrator starts an access review of one group with another account as its reviewer;
 * the reviewer, who holds no capability, finds it from the banner and revokes a membership; the
 * administrator closes the review, the membership goes, and the CSV export downloads.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ensureTestUser, runSeedScript } from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const REVIEWER = 'testreviewer';
const REVIEWER_PASSWORD = 'TestReviewerPass2026!';
const MEMBER = 'testreviewee';
const MEMBER_PASSWORD = 'TestRevieweePass2026!';
const GROUP = 'E2E reviewed';
const CAMPAIGN = 'E2E access review';

function cleanUp(): void {
  runSeedScript(`
    await sql\`DELETE FROM access_review_campaigns WHERE name = \${${JSON.stringify(CAMPAIGN)}}\`;
    await sql\`DELETE FROM groups WHERE name = \${${JSON.stringify(GROUP)}}\`;
    await sql.close();
  `);
}

function seedGroup(): void {
  runSeedScript(`
    const now = new Date().toISOString();
    const [group] = await sql\`INSERT INTO groups (name, source, "createdAt", "updatedAt")
      VALUES (\${${JSON.stringify(GROUP)}}, 'ui', \${now}, \${now}) RETURNING id\`;
    const [member] = await sql\`SELECT id FROM users WHERE email = \${${JSON.stringify(`${MEMBER}@localhost`)}}\`;
    await sql\`INSERT INTO group_members ("groupId", "userId", "createdAt") VALUES (\${group.id}, \${member.id}, \${now})\`;
    await sql.close();
  `);
}

async function graphql(page: Page, query: string, variables: Record<string, unknown> = {}) {
  const res = await page.request.post('/api/graphql', {
    headers: { Origin: 'http://localhost:3000' },
    data: { query, variables },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { data?: Record<string, any>; errors?: unknown[] };
  expect(body.errors).toBeUndefined();
  return body.data!;
}

test.describe('Access reviews', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(() => {
    cleanUp();
    ensureTestUser(REVIEWER, REVIEWER_PASSWORD, 'user');
    ensureTestUser(MEMBER, MEMBER_PASSWORD, 'user');
    seedGroup();
  });
  test.afterAll(cleanUp);

  test('an administrator starts a review of one group', async ({ page }) => {
    await page.goto('/users/access-reviews');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Access reviews' })).toBeVisible();
    // The dialog offers the scope, reviewers and due date; the date picker is created through the
    // API below, since its calendar is the component's own and not this feature's.
    await page.getByRole('button', { name: 'Start' }).click();
    const dialog = page.getByRole('dialog', { name: 'New access review' });
    await expect(dialog.getByRole('combobox', { name: /What to review/ })).toBeVisible();
    await page.keyboard.press('Escape');

    const { groups } = await graphql(page, '{ groups { id name } }');
    const { users } = await graphql(page, '{ users { id email } }');
    const group = groups.find((entry: { name: string }) => entry.name === GROUP);
    const reviewer = users.find(
      (entry: { email: string }) => entry.email === `${REVIEWER}@localhost`,
    );
    const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await graphql(page, 'mutation($input: JSON!) { createAccessReview(input: $input) { id } }', {
      input: {
        name: CAMPAIGN,
        scope: 'group',
        scopeRef: String(group.id),
        dueOn: due,
        reviewerIds: [reviewer.id],
      },
    });
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByRole('link', { name: CAMPAIGN })).toBeVisible();
    await expect(page.getByText('0 of 1 decided')).toBeVisible();
  });

  test.describe('the reviewer', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    let context: BrowserContext;

    test.beforeAll(async ({ browser }) => {
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('http://localhost:3000/login');
      await waitForHydration(page);
      await signInWithCredentials(page, REVIEWER, REVIEWER_PASSWORD);
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
      await page.close();
    });

    test.afterAll(async () => {
      await context?.close();
    });

    test('finds the item from the banner and revokes it', async () => {
      const page = await context.newPage();
      await page.goto('http://localhost:3000/');
      await waitForHydration(page);
      await expect(page.getByText('You have 1 access review item to decide')).toBeVisible();
      await page.getByRole('link', { name: 'Review' }).click();
      await page.waitForURL(/\/users\/access-reviews/);
      await waitForHydration(page);
      await page.getByRole('link', { name: CAMPAIGN }).click();
      await waitForHydration(page);
      await expect(
        page.getByRole('cell', { name: new RegExp(`${MEMBER}@localhost`) }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Decide' }).click();
      const dialog = page.getByRole('dialog', { name: new RegExp(`Decide on ${MEMBER}`) });
      await dialog.getByRole('radio', { name: 'Revoke it' }).click();
      await dialog.getByLabel('Note').fill('Left the team');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Left the team')).toBeVisible();
      // A reviewer may not close it, nor export it.
      await expect(page.getByRole('button', { name: 'Close' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Export' })).toHaveCount(0);
      await page.close();
    });
  });

  test('the administrator closes it, which removes the membership, and exports it', async ({
    page,
  }) => {
    await page.goto('/users/access-reviews');
    await waitForHydration(page);
    await page.getByRole('link', { name: CAMPAIGN }).click();
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Applied', { exact: true })).toBeVisible();

    const { groups } = await graphql(page, '{ groups { name members { email } } }');
    const group = groups.find((entry: { name: string }) => entry.name === GROUP);
    expect(group.members).toEqual([]);

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^access-review-e2e-access-review\.csv$/);
  });
});
