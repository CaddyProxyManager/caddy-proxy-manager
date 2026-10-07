/**
 * Better Auth's real routes, the SCIM plugin among them, against a fresh database, with a SCIM
 * connection made through CPM's model: what a SCIM test needs to act as an identity provider.
 */
import { afterEach } from 'bun:test';
import { createTestDatabase } from './db';
import { TEST_ENV } from './env';
import { reloadConfig } from './config';
import { reloadDbModule } from './fresh-db';
import { capabilitiesOf } from './access';

export const ORIGIN = 'http://localhost:3000';
export const SCIM = '/api/auth/scim/v2';
export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

const cleanups: Array<() => void | Promise<void>> = [];

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

/** Call once per test file, at its top level. */
export function registerScimCleanup() {
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
    process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
    process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
    delete process.env.AUTH_RATE_LIMIT_ENABLED;
    resetDbModuleState();
  });
}

export type ScimAnswer = {
  status: number;
  contentType: string | null;
  location: string | null;
  body: any;
};

export async function bootScim(connection: Record<string, unknown> = {}) {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  process.env.DATABASE_URL = database.url;
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  resetDbModuleState();
  await reloadConfig();

  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());
  const db = dbModule.default;

  const users = await import('@/src/lib/models/user');
  const owner = await users.createUser({
    email: 'owner@example.com',
    provider: 'credentials',
    subject: 'owner@example.com',
    role: 'admin',
  });
  const actor = { userId: owner.id, capabilities: capabilitiesOf('admin') };

  const connections = await import('@/src/lib/scim/connections');
  const authServer = await import('@/src/lib/auth/server');
  // Or getAuth() hands back the instance built on the previous boot's database.
  authServer.invalidateProviderCache();
  const auth = (await authServer.getAuth()) as any;

  const made =
    schema.schemaDialect === 'postgres'
      ? await connections.createScimConnection({ name: 'Test IdP', ...connection }, actor)
      : null;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token: string | null | undefined = made?.token,
  ): Promise<ScimAnswer> => {
    const headers: Record<string, string> = { 'content-type': 'application/scim+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response: Response = await auth.handler(
      new Request(`${ORIGIN}${SCIM}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      body: parsed,
    };
  };

  const createUser = (userName: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/Users', {
      schemas: [USER_SCHEMA],
      userName,
      emails: [{ value: userName, primary: true, type: 'work' }],
      name: { givenName: 'Test', familyName: 'Person' },
      active: true,
      ...extra,
    });

  const createGroup = (displayName: string, members: string[] = [], extra = {}) =>
    call('POST', '/Groups', {
      schemas: [GROUP_SCHEMA],
      displayName,
      members: members.map((value) => ({ value })),
      ...extra,
    });

  const patch = (path: string, Operations: unknown[]) =>
    call('PATCH', path, { schemas: [PATCH_SCHEMA], Operations });

  return {
    db,
    schema,
    auth,
    owner,
    actor,
    connections,
    connection: made?.connection ?? null,
    token: made?.token ?? null,
    call,
    createUser,
    createGroup,
    patch,
  };
}
