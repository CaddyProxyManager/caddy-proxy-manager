/**
 * The forward-auth portal must not offer a form that can only fail: a protected site on an
 * undeclared port gets the reason instead, a rid beside rd is ignored, and repeated rd/rid
 * parameters are refused.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';

// Settings resolve through the database: its own, not the app's connection every file shares.
const testDb = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => testDb));

const { testTranslator } = await import('../helpers/next-intl');

const fa = vi.hoisted(() => ({
  isForwardAuthDomain: vi.fn(),
  createRedirectIntent: vi.fn(),
  getDisallowedForwardAuthPort: vi.fn(),
  redirectIntentWantsCaptcha: vi.fn(),
}));

vi.mock('../../src/lib/auth', () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock('../../src/lib/auth-policy', () => ({
  localUsersDisabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/lib/models/oauth-providers', () => ({
  getProviderDisplayList: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/models/forward-auth', () => fa);
vi.mock('../../src/lib/captcha/settings', () => ({
  getActiveCaptcha: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/lib/client-ip', () => ({
  getClientIp: vi.fn().mockResolvedValue('203.0.113.9'),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

const { default: PortalPage } = await import('../../src/app/(auth)/portal/page');

type FormProps = {
  rid: string;
  hasRedirect: boolean;
  targetDomain: string;
  errorMessage?: string | null;
};

async function renderPortal(searchParams: Record<string, string | string[]>): Promise<FormProps> {
  const element = (await PortalPage({ searchParams: Promise.resolve(searchParams) })) as {
    props: FormProps;
  };
  return element.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  fa.isForwardAuthDomain.mockResolvedValue(true);
  fa.getDisallowedForwardAuthPort.mockResolvedValue(null);
  fa.createRedirectIntent.mockResolvedValue('rid-from-intent');
  fa.redirectIntentWantsCaptcha.mockResolvedValue(false);
});

describe('portal page', () => {
  it('creates a redirect intent for a valid target', async () => {
    const props = await renderPortal({ rd: 'https://app.example.com/path?a=1&b=2' });
    expect(fa.createRedirectIntent).toHaveBeenCalledWith('https://app.example.com/path?a=1&b=2');
    expect(props.rid).toBe('rid-from-intent');
    expect(props.errorMessage).toBeNull();
  });

  it('explains an undeclared port instead of creating an intent', async () => {
    fa.getDisallowedForwardAuthPort.mockResolvedValue('8443');
    const props = await renderPortal({ rd: 'https://app.example.com:8443/' });

    expect(fa.createRedirectIntent).not.toHaveBeenCalled();
    expect(props.rid).toBe('');
    expect(props.targetDomain).toBe('app.example.com');
    expect(props.errorMessage).toContain('port 8443');
  });

  it('ignores a rid that arrives beside rd', async () => {
    const props = await renderPortal({ rd: 'https://app.example.com/', rid: 'a'.repeat(32) });
    expect(fa.createRedirectIntent).toHaveBeenCalledWith('https://app.example.com/');
    expect(props.rid).toBe('rid-from-intent');
  });

  it.each([
    ['repeated rd', { rd: ['https://app.example.com/', 'https://other.example.com/'] }],
    ['repeated rid', { rid: ['a'.repeat(32), 'b'.repeat(32)] }],
    [
      'rd with repeated rid',
      { rd: 'https://app.example.com/', rid: ['a'.repeat(32), 'b'.repeat(32)] },
    ],
  ])('rejects a %s', async (_name, searchParams) => {
    const props = await renderPortal(searchParams);
    expect(fa.createRedirectIntent).not.toHaveBeenCalled();
    expect(props.rid).toBe('');
    expect(props.hasRedirect).toBe(true);
    expect(props.errorMessage).toMatch(/invalid/i);
  });

  it('keeps the OAuth return flow working with a single rid', async () => {
    const props = await renderPortal({ rid: 'c'.repeat(32) });
    expect(props.rid).toBe('c'.repeat(32));
    expect(props.errorMessage).toBeNull();
  });
});
