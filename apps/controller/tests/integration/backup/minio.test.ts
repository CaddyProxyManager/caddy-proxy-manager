/**
 * The S3 store against a real S3 implementation, MinIO in a throwaway container. Skipped, saying
 * why, only when Docker is not there to start it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { S3Client } from 'bun';
import {
  MINIO_BUCKET,
  MINIO_PASSWORD,
  MINIO_USER,
  type Minio,
  minioUnavailable,
  startMinio,
} from '../../helpers/minio';
import { s3Store, type S3DestinationConfig } from '../../../src/lib/backup/storage';
import { testDestination } from '../../../src/lib/backup/destinations';

const unavailable = await minioUnavailable();
if (unavailable) {
  // The skip is reported as a pass; say why it was skipped.
  console.warn(`[minio] Skipping the MinIO tests: ${unavailable}`);
}

describe.skipIf(unavailable !== null)('S3 destination against MinIO', () => {
  let minio: Minio;
  let config: S3DestinationConfig;

  beforeAll(async () => {
    minio = await startMinio();
    config = {
      endpoint: minio.endpoint,
      region: '',
      bucket: MINIO_BUCKET,
      accessKeyId: MINIO_USER,
      secretAccessKey: MINIO_PASSWORD,
      virtualHostedStyle: false,
    };
  }, 120_000);

  afterAll(async () => {
    await minio?.stop();
  });

  it('passes the destination test: write, read back, delete', async () => {
    await testDestination({
      ...config,
      id: 1,
      name: 'minio',
      kind: 's3',
      prefix: 'probe/',
      path: '',
      createdAt: '',
      updatedAt: '',
    });
    expect(await s3Store(config).list('probe/')).toEqual([]);
  });

  it('writes, lists, reads back and deletes', async () => {
    const store = s3Store(config);
    const body = new TextEncoder().encode('a small backup');
    await store.write('cpm/nightly/cpm-backup-2026-10-06-02-00-00.cpmbak', body);
    const listed = await store.list('cpm/');
    expect(listed.map((object) => object.key)).toEqual([
      'cpm/nightly/cpm-backup-2026-10-06-02-00-00.cpmbak',
    ]);
    expect(listed[0].size).toBe(body.length);
    expect((await store.read('cpm/nightly/cpm-backup-2026-10-06-02-00-00.cpmbak')).toString()).toBe(
      'a small backup',
    );
    expect(
      (await store.readHead('cpm/nightly/cpm-backup-2026-10-06-02-00-00.cpmbak', 7)).toString(),
    ).toBe('a small');
    await store.delete('cpm/nightly/cpm-backup-2026-10-06-02-00-00.cpmbak');
    expect(await store.list('cpm/')).toEqual([]);
  });

  it('uploads a large backup in parts through the writer', async () => {
    const partSize = 5 * 1024 * 1024;
    const store = s3Store(config, { partSize });
    const data = new Uint8Array(partSize * 2 + 12345);
    for (let i = 0; i < data.length; i += 4096) data[i] = i % 251;
    await store.write('multipart/big.cpmbak', data);
    const back = await store.read('multipart/big.cpmbak');
    expect(back.length).toBe(data.length);
    expect(Buffer.compare(back, Buffer.from(data))).toBe(0);
    // A multipart upload's ETag ends in its part count; a single PUT's has none.
    const stat = await new S3Client({ ...config }).stat('multipart/big.cpmbak');
    expect(stat.etag.replaceAll('"', '')).toEndWith('-3');
    await store.delete('multipart/big.cpmbak');
  }, 60_000);

  it('works virtual-hosted style too', async () => {
    const store = s3Store({
      ...config,
      endpoint: `http://localhost:${minio.port}`,
      virtualHostedStyle: true,
    });
    await store.write('vhost/one.cpmbak', new TextEncoder().encode('virtual'));
    expect((await store.list('vhost/')).map((object) => object.key)).toEqual(['vhost/one.cpmbak']);
    expect((await store.read('vhost/one.cpmbak')).toString()).toBe('virtual');
    await store.delete('vhost/one.cpmbak');
  });
});
