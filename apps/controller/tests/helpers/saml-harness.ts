/**
 * Better Auth's real routes against a fresh database, with a SAML provider registered through
 * CPM's model: what a SAML test needs to start a sign-in and post an IdP's answer back.
 */
import { afterEach } from 'bun:test';
import { createTestDatabase } from './db';
import { TEST_ENV } from './env';
import { reloadConfig } from './config';
import { reloadDbModule } from './fresh-db';
import {
  type ResponseOptions,
  type TestIdp,
  createTestIdp,
  encodeResponse,
  readAuthnRequest,
  signedResponse,
} from './saml-idp';

export const ORIGIN = 'http://localhost:3000';

const cleanups: Array<() => void | Promise<void>> = [];

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

/** Call once per test file, at its top level. */
export function registerSamlCleanup() {
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
    process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
    process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
    delete process.env.AUTH_RATE_LIMIT_ENABLED;
    delete process.env.AUTH_ALLOW_OAUTH_REGISTRATION;
    delete process.env.AUTH_DISABLE_LOCAL_USERS;
    resetDbModuleState();
  });
}

/** One browser: the cookies Better Auth sets, sent back on the next request. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }
}

export async function bootSaml(
  options: { provider?: Record<string, unknown>; idp?: TestIdp; env?: Record<string, string> } = {},
) {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  process.env.DATABASE_URL = database.url;
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  Object.assign(process.env, options.env ?? {});
  resetDbModuleState();
  await reloadConfig();

  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());
  const db = dbModule.default;

  const idp = options.idp ?? createTestIdp();
  const samlModel = await import('@/src/lib/models/saml-providers');
  const provider = await samlModel.createSamlProvider(
    { name: 'Test IdP', metadataXml: idp.metadata(), ...(options.provider ?? {}) },
    { baseUrl: ORIGIN },
  );

  const authServer = await import('@/src/lib/auth/server');
  // Or getAuth() hands back the instance built on the previous boot's database.
  authServer.invalidateProviderCache();
  // betterAuth's instance type is generated from its config; the test tree allows `any`.
  const auth = (await authServer.getAuth()) as any;

  const call = async (
    jar: CookieJar,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    form = false,
  ) => {
    const headers: Record<string, string> = { origin: ORIGIN, cookie: jar.header() };
    let payload: string | undefined;
    if (body !== undefined && form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body as Record<string, string>).toString();
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response: Response = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, { method, headers, body: payload }),
    );
    jar.take(response);
    return response;
  };

  const acsUrl = `${ORIGIN}/api/auth/sso/saml2/sp/acs/${provider.id}`;

  /** The SP-initiated half: CPM's AuthnRequest, as the IdP would receive it. */
  const start = async (jar = new CookieJar(), providerId = provider.id) => {
    const response = await call(jar, 'POST', '/sign-in/sso', {
      providerId,
      callbackURL: '/',
      errorCallbackURL: '/login',
    });
    const body = (await response.json().catch(() => null)) as { url?: string } | null;
    return { jar, response, request: body?.url ? readAuthnRequest(body.url) : null };
  };

  /** Posts a response to the consumer; `null` RelayState leaves it out. */
  const post = async (
    jar: CookieJar,
    xml: string,
    relayState: string | null,
    providerId = provider.id,
  ) =>
    call(
      jar,
      'POST',
      `/sso/saml2/sp/acs/${providerId}`,
      {
        SAMLResponse: encodeResponse(xml),
        ...(relayState === null ? {} : { RelayState: relayState }),
      },
      true,
    );

  /** Defaults that pass; a test overrides the one thing it is about. */
  const responseFor = (inResponseTo: string | null, overrides: Partial<ResponseOptions> = {}) => ({
    inResponseTo,
    destination: acsUrl,
    audience: provider.spEntityId,
    nameId: 'saml-user-1',
    attributes: { email: 'saml.user@example.com', displayName: 'Saml User' },
    ...overrides,
  });

  /** A whole sign-in that should succeed, unless `overrides` breaks it. */
  const signIn = async (overrides: Partial<ResponseOptions> = {}) => {
    const { jar, request } = await start();
    if (!request) throw new Error('No AuthnRequest');
    const response = await post(
      jar,
      signedResponse(idp, responseFor(request.id, overrides)),
      request.relayState,
    );
    return { jar, response, request };
  };

  return {
    db,
    schema,
    idp,
    provider,
    auth,
    call,
    start,
    post,
    responseFor,
    signIn,
    acsUrl,
    samlModel,
  };
}

/** Where a consumer response sends the browser, and the error it carries if any. */
export function outcome(response: Response): {
  status: number;
  location: string;
  error: string | null;
} {
  const location = response.headers.get('location') ?? '';
  let error: string | null = null;
  try {
    error = new URL(location, ORIGIN).searchParams.get('error');
  } catch {
    error = null;
  }
  return { status: response.status, location, error };
}
