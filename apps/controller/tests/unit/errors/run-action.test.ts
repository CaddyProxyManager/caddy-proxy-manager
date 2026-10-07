import { describe, it, expect } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

vi.mock('next-intl/server', () => nextIntlServerMock());

import messages from '../../../messages/en.json';
import { redirect } from 'next/navigation';
import { domainError } from '@/src/lib/errors/domain-error';
import { runAction } from '@/src/lib/errors/run-action';
import { unwrap } from '@/src/lib/errors/action-result';

describe('runAction', () => {
  it('returns what the action returned', async () => {
    expect(await runAction(async () => ({ id: 7 }))).toEqual({ ok: true, data: { id: 7 } });
  });

  it('says a DomainError in words, from the catalog', async () => {
    const result = await runAction(async () => {
      throw domainError('cannotDeleteOwnAccount');
    });
    expect(result).toEqual({ ok: false, error: messages.errors.cannotDeleteOwnAccount });
  });

  it('formats a list param, as the CA delete dialog shows the hosts still using it', async () => {
    const result = await runAction(async () => {
      throw domainError('caCertificateInUse', { names: ['alpha', 'beta'] }, { status: 409 });
    });
    expect(result).toEqual({
      ok: false,
      error: 'CA certificate is in use by proxy host(s): alpha, beta',
    });
  });

  it('keeps a plain Error its text, which may already be translated', async () => {
    const result = await runAction(async () => {
      throw new Error('Export password is too short');
    });
    expect(result).toEqual({ ok: false, error: 'Export password is too short' });
  });

  it('lets redirect() through, which signals by throwing', async () => {
    let caught: unknown;
    try {
      await runAction(async () => redirect('/login'));
    } catch (error) {
      caught = error;
    }
    expect(String((caught as { digest?: string })?.digest)).toStartWith('NEXT_REDIRECT');
  });
});

describe('unwrap', () => {
  it('hands back the data', () => {
    expect(unwrap({ ok: true, data: 3 })).toBe(3);
  });

  it('throws the message for the caller to show', () => {
    expect(() => unwrap({ ok: false, error: 'Nope' })).toThrow('Nope');
  });
});
