import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBackup, readBackupHeader, sealBackup } from '../../../src/lib/backup/format';

const PASSPHRASE = 'correct horse battery';

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

describe('backup format v3', () => {
  it('compresses before sealing and round-trips', async () => {
    const rows = Array.from({ length: 2000 }, (_, id) => ({
      id,
      name: `host-${id}`,
      note: 'x'.repeat(40),
    }));
    const payload = { tables: { proxy_hosts: rows } };
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '3.7.0' });
    const { header } = readBackupHeader(file);
    expect(header.version).toBe(3);
    expect(header.compression).toBe('zstd');
    // Compressed: far smaller than the JSON it carries.
    expect(file.length).toBeLessThan(JSON.stringify(payload).length / 4);
    const opened = await openBackup(file, PASSPHRASE);
    expect(opened.tables).toEqual(payload.tables);
  });

  it('still opens a version 2 file', async () => {
    const file = readFileSync(join(import.meta.dir, 'v2-fixture.cpmbak'));
    expect(readBackupHeader(file).header.version).toBe(2);
    const opened = await openBackup(file, 'version two passphrase');
    expect(opened.tables.proxy_hosts?.[0]).toMatchObject({ id: 41, name: 'from-v2' });
  });

  it('refuses a file whose compression field was edited', async () => {
    const file = await sealBackup({ tables: {} }, PASSPHRASE, { appVersion: '3.7.0' });
    for (const value of [undefined, 'none', 'gzip']) {
      const forged = tamper(file, (header) => {
        if (value === undefined) delete header.compression;
        else header.compression = value;
      });
      await expect(openBackup(forged, PASSPHRASE)).rejects.toMatchObject({
        code: 'backupPassphraseWrong',
      });
    }
  });

  it('refuses a v3 file relabelled as v2', async () => {
    const file = await sealBackup({ tables: {} }, PASSPHRASE, { appVersion: '3.7.0' });
    const forged = tamper(file, (header) => {
      header.version = 2;
      delete header.compression;
    });
    await expect(openBackup(forged, PASSPHRASE)).rejects.toMatchObject({
      code: 'backupPassphraseWrong',
    });
  });

  it('stops decompressing at the cap rather than inflating the payload', async () => {
    // Megabytes of one character compress to almost nothing: a bomb in miniature.
    const payload = { tables: { filler: [{ text: 'a'.repeat(4 * 1024 * 1024) }] } };
    const file = await sealBackup(payload, PASSPHRASE, { appVersion: '3.7.0' });
    expect(file.length).toBeLessThan(64 * 1024);
    const refused = await openBackup(file, PASSPHRASE, { maxPayloadBytes: 1024 * 1024 }).catch(
      (error: unknown) => error as { code: string; cause?: { code?: string } },
    );
    expect(refused).toMatchObject({ code: 'backupPayloadTooLarge' });
    expect((refused as { cause?: { code?: string } }).cause?.code).toBe('ERR_BUFFER_TOO_LARGE');
  });
});
