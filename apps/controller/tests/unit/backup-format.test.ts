import { describe, expect, it } from 'bun:test';
import { openBackup, readBackupHeader, sealBackup } from '../../src/lib/backup/format';

const PASSPHRASE = 'correct horse battery';
const payload = { tables: { proxy_hosts: [{ id: 1 }], settings: [] } };

/** Rewrites the cleartext header without touching the sealed body. */
function tamper(file: Buffer, edit: (header: Record<string, unknown>) => void): Buffer {
  const text = file.toString('utf8');
  const first = text.indexOf('\n');
  const second = text.indexOf('\n', first + 1);
  const header = JSON.parse(text.slice(first + 1, second));
  edit(header);
  return Buffer.from(
    `${text.slice(0, first)}\n${JSON.stringify(header)}\n${text.slice(second + 1)}`,
  );
}

describe('backup header', () => {
  it('round-trips, handing back the header it authenticated', async () => {
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '3.1.0' });
    const opened = await openBackup(file, PASSPHRASE);
    expect(opened.tables).toEqual(payload.tables);
    expect(opened.header.appVersion).toBe('3.1.0');
  });

  it('refuses a newer backup whose cleartext version was lowered', async () => {
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '999.0.0' });
    const forged = tamper(file, (header) => {
      header.appVersion = '1.0.0';
    });
    expect(readBackupHeader(forged).header.appVersion).toBe('1.0.0');
    await expect(openBackup(forged, PASSPHRASE)).rejects.toMatchObject({
      code: 'backupPassphraseWrong',
    });
  });

  it('refuses edited row counts or creation time', async () => {
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '3.1.0' });
    for (const edit of [
      (header: Record<string, unknown>) => {
        (header.counts as Record<string, number>).proxy_hosts = 0;
      },
      (header: Record<string, unknown>) => {
        header.createdAt = '2000-01-01T00:00:00.000Z';
      },
    ]) {
      await expect(openBackup(tamper(file, edit), PASSPHRASE)).rejects.toMatchObject({
        code: 'backupPassphraseWrong',
      });
    }
  });

  it('still opens when only the key order in the header changed', async () => {
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '3.1.0' });
    const reordered = tamper(file, (header) => {
      const counts = header.counts as Record<string, number>;
      header.counts = Object.fromEntries(Object.entries(counts).reverse());
    });
    expect((await openBackup(reordered, PASSPHRASE)).tables).toEqual(payload.tables);
  });

  it('does not accept the unauthenticated version 1 format', async () => {
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '3.1.0' });
    const old = tamper(file, (header) => {
      header.version = 1;
    });
    expect(() => readBackupHeader(old)).toThrow();
  });
});
