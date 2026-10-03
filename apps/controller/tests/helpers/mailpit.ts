/**
 * The stack's mailpit: web relays to mailpit:1025 with SMTP auth, specs read what arrived over its
 * API on the host's 8025.
 */
import { expect, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';
import { pageSave } from './settings-nav';

const API = 'http://localhost:8025/api/v1';

/** Enforced by mailpit (MP_SMTP_AUTH), so a delivered message proves the stored password. */
export const SMTP = {
  host: 'mailpit',
  port: 1025,
  username: 'cpm-smtp',
  password: 'SmtpE2ePassword2026',
};
/** Registry settings are stored under a `config:` prefix. */
export const SMTP_SETTING_KEYS = [
  'enabled',
  'host',
  'port',
  'security',
  'username',
  'password',
  'from',
].map((field) => `config:smtp_${field}`);

type Summary = { ID: string; Subject: string; To: { Address: string }[] };

export async function deleteAllMail(): Promise<void> {
  await fetch(`${API}/messages`, { method: 'DELETE' });
}

/** The newest message to `address`, polled for until it arrives. */
export async function waitForMail(
  address: string,
  timeoutMs = 30_000,
): Promise<{ subject: string; text: string }> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${API}/search?query=${encodeURIComponent(`to:"${address}"`)}`);
        if (!res.ok) return false;
        found = ((await res.json()) as { messages: Summary[] }).messages[0];
        return found !== undefined;
      },
      { timeout: timeoutMs, intervals: [1_000] },
    )
    .toBe(true);
  const message = (await (await fetch(`${API}/message/${found!.ID}`)).json()) as {
    Subject: string;
    Text: string;
  };
  return { subject: message.Subject, text: message.Text };
}

export function firstLink(text: string, prefix: string): string {
  const link = text.split(/\s+/).find((word) => word.startsWith(prefix));
  expect(link, `a link starting ${prefix}`).toBeDefined();
  return link!;
}

/** Settings -> Email, filled and saved through the page's own save bar. */
export async function configureSmtp(page: Page, password = SMTP.password): Promise<void> {
  await page.goto('/settings/email');
  await waitForHydration(page);
  const enabled = page.getByRole('switch', { name: /^send email/i });
  if (!(await enabled.isChecked())) await enabled.click();
  await page.getByRole('textbox', { name: /^smtp server/i }).fill(SMTP.host);
  await page.getByRole('combobox', { name: /^encryption/i }).click();
  await page.getByRole('option', { name: /^none/i }).click();
  await page.getByRole('spinbutton', { name: /^port/i }).fill(String(SMTP.port));
  await page.getByRole('textbox', { name: /^username/i }).fill(SMTP.username);
  await page.getByRole('textbox', { name: /^password/i }).fill(password);
  await page.getByRole('textbox', { name: /^sender address/i }).fill('cpm@example.com');
  await expect(pageSave(page)).toBeVisible({ timeout: 10_000 });
  await pageSave(page).click({ force: true });
  await expect(page.getByText(/email settings saved/i).first()).toBeVisible({ timeout: 15_000 });
}

/**
 * Back to no email, through the form: web caches registry settings until a save invalidates
 * them, so deleting the rows alone would leave it sending until a restart. The rows go after.
 */
export async function removeSmtp(page: Page): Promise<void> {
  await page.goto('/settings/email');
  await waitForHydration(page);
  await page.getByRole('textbox', { name: /^smtp server/i }).fill('');
  // An empty username clears the stored password too.
  await page.getByRole('textbox', { name: /^username/i }).fill('');
  await page.getByRole('textbox', { name: /^sender address/i }).fill('');
  const enabled = page.getByRole('switch', { name: /^send email/i });
  if (await enabled.isChecked()) await enabled.click();
  await expect(pageSave(page)).toBeVisible({ timeout: 10_000 });
  await pageSave(page).click({ force: true });
  await expect(page.getByText(/email settings saved/i).first()).toBeVisible({ timeout: 15_000 });
}
