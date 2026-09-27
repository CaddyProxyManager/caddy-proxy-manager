import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
  };
});

import {
  createOAuthProvider,
  getOAuthProvider,
  updateOAuthProvider,
} from '../../src/lib/models/oauth-providers';
import { oauthProviders } from '../../src/lib/db/schema';
import { isEncryptedSecret } from '../../src/lib/secret';

beforeEach(async () => {
  await ctx.db.delete(oauthProviders);
});

describe('OAuth provider secret persistence', () => {
  it('preserves an existing secret for blank updates and rotates only explicitly', async () => {
    const created = await createOAuthProvider({
      name: 'OIDC',
      clientId: 'client-id',
      clientSecret: 'original-client-secret',
    });
    const originalRow = await ctx.db.query.oauthProviders.findFirst({
      where: (table, { eq }) => eq(table.id, created.id),
    });
    expect(isEncryptedSecret(originalRow!.clientSecret)).toBe(true);

    await updateOAuthProvider(created.id, { clientSecret: '   ' });
    const preservedRow = await ctx.db.query.oauthProviders.findFirst({
      where: (table, { eq }) => eq(table.id, created.id),
    });
    expect(preservedRow!.clientSecret).toBe(originalRow!.clientSecret);
    expect((await getOAuthProvider(created.id))!.clientSecret).toBe('original-client-secret');

    await updateOAuthProvider(created.id, { clientSecret: ' replacement-client-secret ' });
    expect((await getOAuthProvider(created.id))!.clientSecret).toBe('replacement-client-secret');
  });
});
