/** The account step is one-time: two unauthenticated setup requests racing must not both win. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const schemaModule = await import('@/src/lib/db/schema');
const { testTranslator } = await import('../helpers/next-intl');
ctx.db = await createTestDb();

// Holds each user insert until two have arrived (or 300 ms pass): without a claim, both racers
// pass the empty-instance check first and meet here.
let arrived: (() => void)[] = [];
function barrier(): Promise<void> {
  return new Promise((resolve) => {
    arrived.push(resolve);
    if (arrived.length >= 2) {
      for (const release of arrived) release();
      arrived = [];
    } else {
      setTimeout(() => {
        arrived = arrived.filter((release) => release !== resolve);
        resolve();
      }, 300);
    }
  });
}
const gatedDb = new Proxy({} as TestDb, {
  get(_, prop) {
    const db = ctx.db as unknown as Record<string | symbol, unknown>;
    if (prop !== 'insert') {
      const value = db[prop];
      return typeof value === 'function' ? value.bind(ctx.db) : value;
    }
    return (table: unknown) => {
      const builder = ctx.db.insert(table as typeof schemaModule.users);
      if (table !== schemaModule.users) return builder;
      return {
        values: (row: unknown) => {
          const pending = builder.values(row as never);
          return {
            returning: () => barrier().then(() => pending.returning()),
          };
        },
      };
    };
  },
});

vi.mock('@/src/lib/db', () => ({
  default: gatedDb,
  db: gatedDb,
  client: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));
// A redirect ends the action by throwing; here it just marks the winner.
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const { createFirstAdmin, configureFirstOAuthProvider } = await import('@/src/app/setup/actions');

const PASSWORD = 'A long enough Passphrase 1!';

function adminForm(username: string) {
  const form = new FormData();
  form.set('username', username);
  form.set('password', PASSWORD);
  form.set('passwordConfirmation', PASSWORD);
  return form;
}

function oauthForm() {
  const form = new FormData();
  form.set('providerName', 'Authentik');
  form.set('clientId', 'client');
  form.set('clientSecret', 'secret');
  form.set('issuer', 'https://idp.example.com/application/o/cpm/');
  return form;
}

/** 'won' when the action redirected on success, otherwise the error it returned. */
async function outcome(run: Promise<{ error: string | null }>): Promise<string> {
  try {
    const state = await run;
    return state.error ?? 'no error';
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('REDIRECT:')) return 'won';
    throw error;
  }
}

beforeEach(async () => {
  await ctx.db.delete(schemaModule.settings);
  await ctx.db.delete(schemaModule.accounts);
  await ctx.db.delete(schemaModule.users);
  await ctx.db.delete(schemaModule.oauthProviders);
});

describe('first-run account step', () => {
  it('creates exactly one administrator when two setups race', async () => {
    const results = await Promise.all([
      outcome(createFirstAdmin({ error: null }, adminForm('operator'))),
      outcome(createFirstAdmin({ error: null }, adminForm('attacker'))),
    ]);
    expect(results.filter((result) => result === 'won')).toHaveLength(1);
    expect(results).toContain(testTranslator('setup.errors')('alreadyCompleted'));
    expect(await ctx.db.select().from(schemaModule.users)).toHaveLength(1);
  });

  it('lets only one of a password setup and an OAuth setup through', async () => {
    const results = await Promise.all([
      outcome(createFirstAdmin({ error: null }, adminForm('operator'))),
      outcome(configureFirstOAuthProvider({ error: null }, oauthForm())),
    ]);
    expect(results.filter((result) => result === 'won')).toHaveLength(1);
    const users = await ctx.db.select().from(schemaModule.users);
    const providers = await ctx.db.select().from(schemaModule.oauthProviders);
    expect(users.length + providers.length).toBe(1);
  });

  it('frees the step again after a refused attempt', async () => {
    const taken = adminForm('operator');
    taken.set('passwordConfirmation', 'different');
    expect(await outcome(createFirstAdmin({ error: null }, taken))).not.toBe('won');
    expect(await outcome(createFirstAdmin({ error: null }, adminForm('operator')))).toBe('won');
  });
});
