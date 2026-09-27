/**
 * In-memory Caddy admin, so build-and-apply runs with nothing listening. setup.bun.ts installs one
 * globally; tests asserting on what was sent make their own.
 */
import type {
  CaddyAdminRequest,
  CaddyAdminResponse,
  CaddyAdminTransport,
} from '../../src/lib/caddy-admin';
import { setCaddyAdminTransport } from '../../src/lib/caddy-admin';

export type RecordedRequest = {
  path: string;
  method: string;
  body?: string;
};

export type FakeCaddy = {
  transport: CaddyAdminTransport;
  requests: RecordedRequest[];
  loads: RecordedRequest[];
  lastConfig: () => Record<string, unknown> | null;
  /** Make the next N responses (or all subsequent ones) fail with this status. */
  failWith: (status: number, text?: string) => void;
  failWithNetworkError: (code: 'ECONNREFUSED' | 'ENOTFOUND') => void;
  /** Drives restart detection. */
  setConfigEtag: (etag: string | null) => void;
  reset: () => void;
};

function createFakeCaddy(): FakeCaddy {
  let loadedConfig: Record<string, unknown> | null = null;
  let failure: { status: number; text: string } | null = null;
  let networkError: 'ECONNREFUSED' | 'ENOTFOUND' | null = null;
  let configEtag: string | null = null;
  const requests: RecordedRequest[] = [];
  const loads: RecordedRequest[] = [];

  const transport: CaddyAdminTransport = async (
    request: CaddyAdminRequest,
  ): Promise<CaddyAdminResponse> => {
    const record: RecordedRequest = {
      path: request.path,
      method: request.method,
      body: request.body,
    };
    requests.push(record);

    if (networkError) {
      // Shaped like node:http's, for applyCaddyConfig's error mapping.
      const error = new Error(`connect ${networkError}`) as Error & {
        cause?: NodeJS.ErrnoException;
      };
      error.cause = Object.assign(new Error(networkError), {
        code: networkError,
      }) as NodeJS.ErrnoException;
      throw error;
    }

    if (failure) {
      return { status: failure.status, text: failure.text, headers: {} };
    }

    if (request.method === 'POST' && request.path === '/load') {
      loads.push(record);
      loadedConfig = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : null;
      return { status: 200, text: '', headers: {} };
    }

    if (request.method === 'GET' && request.path === '/config/') {
      return {
        status: 200,
        text: JSON.stringify(loadedConfig ?? {}),
        headers: configEtag ? { etag: configEtag } : {},
      };
    }

    return { status: 404, text: 'not found', headers: {} };
  };

  return {
    transport,
    requests,
    loads,
    lastConfig: () => loadedConfig,
    failWith: (status, text = '') => {
      failure = { status, text };
    },
    failWithNetworkError: (code) => {
      networkError = code;
    },
    setConfigEtag: (etag) => {
      configEtag = etag;
    },
    reset: () => {
      requests.length = 0;
      loads.length = 0;
      loadedConfig = null;
      failure = null;
      networkError = null;
      configEtag = null;
    },
  };
}

export function installFakeCaddy(): FakeCaddy {
  const fake = createFakeCaddy();
  setCaddyAdminTransport(fake.transport);
  return fake;
}
