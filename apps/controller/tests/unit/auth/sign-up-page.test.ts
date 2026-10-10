/**
 * /login/sign-up must not offer a form that can only fail: with self-registration off (or local
 * users off, which the policy folds in) Better Auth refuses the route, so the page sends the
 * visitor back to /login instead.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const ctx = vi.hoisted(() => ({
  auth: vi.fn(),
  selfRegistrationOpen: vi.fn(),
}));

vi.mock('../../../src/lib/auth', () => ({ auth: ctx.auth }));
vi.mock('../../../src/lib/auth/policy', () => ({
  selfRegistrationOpen: ctx.selfRegistrationOpen,
}));
vi.mock('../../../src/lib/branding/app-name', () => ({
  getAppName: vi.fn().mockResolvedValue('Example Proxy'),
}));

const { default: SignUpPage } = await import('../../../src/app/(auth)/login/sign-up/page');

/** Next's redirect() throws; the destination sits in its digest (`NEXT_REDIRECT;type;url;...`). */
async function redirectOf(): Promise<string | null> {
  try {
    await SignUpPage();
    return null;
  } catch (error) {
    const digest = String((error as { digest?: string })?.digest ?? '');
    if (!digest.startsWith('NEXT_REDIRECT')) throw error;
    return digest.split(';')[2] ?? null;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.auth.mockResolvedValue(null);
  ctx.selfRegistrationOpen.mockResolvedValue(true);
});

describe('the sign-up page', () => {
  it('renders the form while self-registration is on', async () => {
    const element = (await SignUpPage()) as { props: { appName: string } };
    expect(element.props.appName).toBe('Example Proxy');
  });

  it('sends a visitor back to /login while self-registration is off', async () => {
    ctx.selfRegistrationOpen.mockResolvedValue(false);
    expect(await redirectOf()).toBe('/login');
  });

  it('sends a signed-in reader to the dashboard, as /login does', async () => {
    ctx.auth.mockResolvedValue({ user: { id: 1 } });
    expect(await redirectOf()).toBe('/');
  });
});
