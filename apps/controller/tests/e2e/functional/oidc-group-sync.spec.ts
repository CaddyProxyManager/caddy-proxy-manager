import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { goToSetting } from '../../helpers/settings-nav';
import { deleteUserByEmail } from '../../helpers/seed';

/**
 * IdP groups to CPM roles and groups, through a real sign-in. The mock IdP's `groups-prefixed`
 * issuer sends a Keycloak-style path group, a prefixed team and an unrelated group;
 * `groups-unmatched` buries its groups under `roles.cpm` and matches no role group.
 */

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const ORIGIN = BASE_URL;

type ApiUser = { id: number; email: string; role: string };
type ApiGroup = {
  id: number;
  name: string;
  source: string;
  members: { userId: number; email: string }[];
};

async function findUser(request: APIRequestContext, email: string) {
  const resp = await request.get(`${API}/users`);
  expect(resp.ok()).toBeTruthy();
  return ((await resp.json()) as ApiUser[]).find((u) => u.email === email);
}

async function listGroups(request: APIRequestContext) {
  const resp = await request.get(`${API}/groups`);
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as ApiGroup[];
}

async function deleteGroupsNamed(request: APIRequestContext, names: string[]) {
  for (const group of await listGroups(request)) {
    if (names.includes(group.name)) {
      await request.delete(`${API}/groups/${group.id}`, { headers: { Origin: ORIGIN } });
    }
  }
}

async function providerIdByName(request: APIRequestContext, name: string) {
  const resp = await request.get(`${API}/oauth-providers`);
  expect(resp.ok()).toBeTruthy();
  return ((await resp.json()) as { id: string; name: string }[]).find((p) => p.name === name)?.id;
}

/** A sessionless context; the mock IdP issues the code without a login form. */
async function signInWith(browser: Browser, providerName: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/login`);
    // A click before hydration submits nothing.
    await waitForHydration(page);
    const button = page.getByRole('button', {
      name: new RegExp(`continue with ${providerName}`, 'i'),
    });
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();
    await page.waitForURL(
      (url) =>
        url.origin === BASE_URL &&
        !url.pathname.startsWith('/api/auth') &&
        !url.pathname.startsWith('/login'),
      { timeout: 30_000 },
    );
    expect(page.url()).not.toContain('error');
  } finally {
    await ctx.close();
  }
}

async function fillMockIssuer(page: Page, issuerId: string) {
  const dialog = page.getByRole('dialog');
  // Server-side URLs use the in-network name, also the token `iss`; the browser uses the host port.
  await dialog.getByLabel(/client id/i).fill('cpm');
  await dialog.getByLabel(/client secret/i).fill('secret');
  await dialog.getByLabel(/issuer url/i).fill(`http://mock-oidc:8080/${issuerId}`);
  await dialog.getByLabel(/authorization url/i).fill(`http://localhost:5557/${issuerId}/authorize`);
  await dialog.getByLabel(/token url/i).fill(`http://mock-oidc:8080/${issuerId}/token`);
  await dialog.getByLabel(/userinfo url/i).fill(`http://mock-oidc:8080/${issuerId}/userinfo`);
}

test.describe('OIDC group sync', () => {
  test.setTimeout(120_000);
  const providerIds: string[] = [];
  const emails: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const email of emails.splice(0)) deleteUserByEmail(email);
    await deleteGroupsNamed(request, ['Team Alpha', 'Team Beta']);
    for (const id of providerIds.splice(0)) {
      await request.delete(`${API}/oauth-providers/${id}`, { headers: { Origin: ORIGIN } });
    }
  });

  test('a prefix configured in Settings maps the role group and mirrors the team', async ({
    page,
    browser,
  }) => {
    const email = 'groups-prefixed@idp.example';
    emails.push(email);
    deleteUserByEmail(email);
    const name = `Groups IdP ${Date.now()}`;

    await goToSetting(page, 'Single sign-on providers');
    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^name/i).fill(name);
    await fillMockIssuer(page, 'groups-prefixed');
    await dialog.getByLabel(/group prefix/i).fill('cpm-');
    await dialog.getByRole('switch', { name: /assign roles from groups/i }).click();
    await dialog.getByRole('switch', { name: /mirror groups into cpm groups/i }).click();
    await dialog.getByRole('button', { name: /^create$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const id = await providerIdByName(page.request, name);
    expect(id, 'provider created').toBeTruthy();
    providerIds.push(id!);

    await signInWith(browser, name);

    const user = await findUser(page.request, email);
    expect(user, 'federated user provisioned').toBeDefined();
    // "/Org/cpm-Operator" is a path group: its last segment carries the prefix.
    expect(user!.role).toBe('operator');

    const groups = await listGroups(page.request);
    const alpha = groups.find((g) => g.name === 'Team Alpha');
    expect(alpha, 'prefixed team mirrored with the prefix stripped').toBeDefined();
    expect(alpha!.source).toBe('oidc');
    expect(alpha!.members.map((m) => m.email)).toContain(email);
    // Neither the role group nor an unprefixed one becomes a CPM group.
    expect(groups.find((g) => g.name.toLowerCase() === 'operator')).toBeUndefined();
    expect(groups.find((g) => g.name === 'unrelated')).toBeUndefined();

    await page.goto('/groups');
    await expect(page.getByText('Team Alpha').first()).toBeVisible({ timeout: 15_000 });
  });

  test('no matching role group gives the default role; a nested claim still mirrors', async ({
    page,
    browser,
  }) => {
    const email = 'groups-unmatched@idp.example';
    emails.push(email);
    deleteUserByEmail(email);
    const name = `Groups Default IdP ${Date.now()}`;
    const created = await page.request.post(`${API}/oauth-providers`, {
      headers: { Origin: ORIGIN },
      data: {
        name,
        type: 'oidc',
        clientId: 'cpm',
        clientSecret: 'secret',
        issuer: 'http://mock-oidc:8080/groups-unmatched',
        authorizationUrl: 'http://localhost:5557/groups-unmatched/authorize',
        tokenUrl: 'http://mock-oidc:8080/groups-unmatched/token',
        userinfoUrl: 'http://mock-oidc:8080/groups-unmatched/userinfo',
        scopes: 'openid email profile',
        groupsClaim: 'roles.cpm',
        roleMappingEnabled: true,
        adminGroup: 'cpm-admins',
        defaultRole: 'operator',
        syncGroups: true,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    providerIds.push((await created.json()).id);

    await signInWith(browser, name);

    const user = await findUser(page.request, email);
    expect(user).toBeDefined();
    expect(user!.role, 'the configured default role, operator included').toBe('operator');
    const beta = (await listGroups(page.request)).find((g) => g.name === 'Team Beta');
    expect(beta?.members.map((m) => m.email)).toContain(email);
  });
});
