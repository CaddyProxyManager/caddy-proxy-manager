/** Rethrowing untouched matters as much: `redirect()` throws, and `skipMigration` redirects. */
import { describe, it, expect } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

vi.mock('next-intl/server', () => nextIntlServerMock());

import messages from '../../messages/en.json';
import { DomainError, domainError } from '@/src/lib/domain-error';
import { withTranslatedErrors } from '@/src/lib/translated-action';

describe('withTranslatedErrors', () => {
  it('returns what the action returned', async () => {
    expect(await withTranslatedErrors(async () => ({ id: 7 }))).toEqual({ id: 7 });
  });

  it('says a DomainError in words, from the catalog', async () => {
    const failing = withTranslatedErrors(async () => {
      throw domainError('cannotDeleteOwnAccount');
    });
    await expect(failing).rejects.toThrow(messages.errors.cannotDeleteOwnAccount);
  });

  it('formats a list param, as the CA delete dialog shows the hosts still using it', async () => {
    const failing = withTranslatedErrors(async () => {
      throw domainError('caCertificateInUse', { names: ['alpha', 'beta'] }, { status: 409 });
    });
    await expect(failing).rejects.toThrow('CA certificate is in use by proxy host(s): alpha, beta');
  });

  it('hands on a plain Error untouched, so redirect() still signals', async () => {
    // Converting it would turn a redirect into an error page.
    const redirectSignal = new Error('NEXT_REDIRECT');
    let caught: unknown;
    try {
      await withTranslatedErrors(async () => {
        throw redirectSignal;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(redirectSignal);
  });

  it('does not leave a DomainError instance for the client to unwrap', async () => {
    // The class does not survive the action boundary, hence resolving the message here.
    let caught: unknown;
    try {
      await withTranslatedErrors(async () => {
        throw domainError('nameRequired');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DomainError);
  });
});
