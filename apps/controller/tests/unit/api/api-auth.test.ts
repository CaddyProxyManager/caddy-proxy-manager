import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

vi.mock('@/src/lib/models/api-tokens', () => ({
  validateToken: vi.fn(),
}));

vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(),
  checkSameOrigin: vi.fn(() => null),
}));

// No groups, so a role's own capabilities decide; this file has no database.
const actualGrants = await import('@/src/lib/models/group-grants');
vi.mock('@/src/lib/models/group-grants', () => ({
  ...actualGrants,
  groupIdsOf: async () => [],
  rolesOfGroups: async () => [],
}));

import {
  authenticateApiRequest,
  requireApiUser,
  ApiAuthError,
  NotFoundError,
  apiErrorResponse,
} from '@/src/lib/api/auth';
import { ApiClientError, ApiConflictError, ApiValidationError } from '@/src/lib/api/errors';
import { domainError } from '@/src/lib/errors/domain-error';
import { validateToken } from '@/src/lib/models/api-tokens';
import { auth, checkSameOrigin } from '@/src/lib/auth';
import { NextResponse } from 'next/server';

const mockValidateToken = vi.mocked(validateToken);
const mockAuth = vi.mocked(auth);

function createMockRequest(
  options: { authorization?: string; method?: string; origin?: string; pathname?: string } = {},
): any {
  return {
    headers: {
      get(name: string) {
        if (name === 'authorization') return options.authorization ?? null;
        if (name === 'origin') return options.origin ?? null;
        return null;
      },
    },
    method: options.method ?? 'GET',
    nextUrl: { pathname: options.pathname ?? '/api/v1/proxy-hosts' },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('authenticateApiRequest', () => {
  it('authenticates via Bearer token', async () => {
    mockValidateToken.mockResolvedValue({
      token: {
        id: 1,
        name: 'test',
        createdBy: 42,
        createdAt: '',
        lastUsedAt: null,
        expiresAt: null,
        scope: 'full',
        permissions: [],
      },
      user: { id: 42, role: 'admin', hasPassword: false, twoFactorEnabled: false },
    });

    const result = await authenticateApiRequest(
      createMockRequest({ authorization: 'Bearer test-token' }),
    );

    expect(result.userId).toBe(42);
    expect(result.role).toBe('admin');
    expect(result.authMethod).toBe('bearer');
    expect(mockValidateToken).toHaveBeenCalledWith('test-token');
  });

  it('rejects invalid Bearer token', async () => {
    mockValidateToken.mockResolvedValue(null);

    await expect(
      authenticateApiRequest(createMockRequest({ authorization: 'Bearer bad-token' })),
    ).rejects.toThrow(ApiAuthError);
  });

  it('falls back to session auth when no Bearer header', async () => {
    mockAuth.mockResolvedValue({
      user: { id: '10', role: 'user', name: 'Test', email: 'test@test.com' },
      expires: '',
    } as any);

    const result = await authenticateApiRequest(createMockRequest());

    expect(result.userId).toBe(10);
    expect(result.role).toBe('user');
    expect(result.authMethod).toBe('session');
  });

  it('throws 401 when neither auth method succeeds', async () => {
    mockAuth.mockResolvedValue(null as any);

    await expect(authenticateApiRequest(createMockRequest())).rejects.toThrow(ApiAuthError);

    try {
      await authenticateApiRequest(createMockRequest());
    } catch (e) {
      expect((e as ApiAuthError).status).toBe(401);
    }
  });
});

describe('requireApiUser', () => {
  it('allows admin users', async () => {
    mockValidateToken.mockResolvedValue({
      token: {
        id: 1,
        name: 'test',
        createdBy: 1,
        createdAt: '',
        lastUsedAt: null,
        expiresAt: null,
        scope: 'full',
        permissions: [],
      },
      user: { id: 1, role: 'admin', hasPassword: false, twoFactorEnabled: false },
    });

    const result = await requireApiUser(createMockRequest({ authorization: 'Bearer token' }));
    expect(result.role).toBe('admin');
  });

  it('rejects non-admin users with 403', async () => {
    mockValidateToken.mockResolvedValue({
      token: {
        id: 1,
        name: 'test',
        createdBy: 2,
        createdAt: '',
        lastUsedAt: null,
        expiresAt: null,
        scope: 'full',
        permissions: [],
      },
      user: { id: 2, role: 'user', hasPassword: false, twoFactorEnabled: false },
    });

    try {
      await requireApiUser(createMockRequest({ authorization: 'Bearer token' }));
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiAuthError);
      expect((e as ApiAuthError).status).toBe(403);
    }
  });
});

describe('requireApiUser', () => {
  it('returns auth result for valid user', async () => {
    mockAuth.mockResolvedValue({
      user: { id: '5', role: 'viewer', name: 'V', email: 'v@test.com' },
      expires: '',
    } as any);

    // Their own sessions: what any account may reach.
    const result = await requireApiUser(createMockRequest({ pathname: '/api/v1/sessions' }));
    expect(result.userId).toBe(5);
    expect(result.role).toBe('viewer');
  });

  it("refuses a role a path's capability it does not hold", async () => {
    mockAuth.mockResolvedValue({
      user: { id: '5', role: 'viewer', name: 'V', email: 'v@test.com' },
      expires: '',
    } as any);

    await expect(requireApiUser(createMockRequest())).rejects.toMatchObject({ status: 403 });
    await expect(
      requireApiUser(createMockRequest({ pathname: '/api/v1/nothing-here' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('CSRF check blocks session-authenticated POST without same origin', async () => {
    mockAuth.mockResolvedValue({
      user: { id: '5', role: 'user', name: 'U', email: 'u@test.com' },
      expires: '',
    } as any);

    const mockCheckSameOrigin = vi.mocked(checkSameOrigin);
    mockCheckSameOrigin.mockReturnValueOnce(
      NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as any,
    );

    await expect(requireApiUser(createMockRequest({ method: 'POST' }))).rejects.toThrow(
      ApiAuthError,
    );

    try {
      mockCheckSameOrigin.mockReturnValueOnce(
        NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as any,
      );
      mockAuth.mockResolvedValue({
        user: { id: '5', role: 'user', name: 'U', email: 'u@test.com' },
        expires: '',
      } as any);
      await requireApiUser(createMockRequest({ method: 'POST' }));
    } catch (e) {
      expect((e as ApiAuthError).status).toBe(403);
    }
  });

  it('CSRF check skips for Bearer-authenticated POST', async () => {
    mockValidateToken.mockResolvedValue({
      token: {
        id: 1,
        name: 'test',
        createdBy: 42,
        createdAt: '',
        lastUsedAt: null,
        expiresAt: null,
        scope: 'full',
        permissions: [],
      },
      user: { id: 42, role: 'admin', hasPassword: false, twoFactorEnabled: false },
    });

    const mockCheckSameOrigin = vi.mocked(checkSameOrigin);
    mockCheckSameOrigin.mockReturnValueOnce(
      NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as any,
    );

    const result = await requireApiUser(
      createMockRequest({ authorization: 'Bearer test-token', method: 'POST' }),
    );
    expect(result.userId).toBe(42);
    expect(result.authMethod).toBe('bearer');
  });
});

describe('requireApiUser - a scoped token', () => {
  function tokenWith(scope: 'full' | 'read' | 'custom', permissions: string[] = []) {
    mockValidateToken.mockResolvedValue({
      token: {
        id: 1,
        name: 'scoped',
        createdBy: 42,
        createdAt: '',
        lastUsedAt: null,
        expiresAt: null,
        scope,
        permissions: permissions as never,
      },
      user: { id: 42, role: 'admin', hasPassword: false, twoFactorEnabled: false },
    });
  }

  it('lets a read-only token read and refuses its writes', async () => {
    tokenWith('read');
    const read = createMockRequest({ authorization: 'Bearer t', pathname: '/api/v1/proxy-hosts' });
    await expect(requireApiUser(read)).resolves.toMatchObject({ userId: 42 });
    const write = createMockRequest({
      authorization: 'Bearer t',
      method: 'POST',
      pathname: '/api/v1/proxy-hosts',
    });
    await expect(requireApiUser(write)).rejects.toMatchObject({ status: 403 });
  });

  it('keeps a custom token to its areas', async () => {
    tokenWith('custom', ['hosts:write']);
    const hosts = createMockRequest({
      authorization: 'Bearer t',
      method: 'DELETE',
      pathname: '/api/v1/proxy-hosts/3',
    });
    await expect(requireApiUser(hosts)).resolves.toMatchObject({ userId: 42 });
    const users = createMockRequest({ authorization: 'Bearer t', pathname: '/api/v1/users' });
    await expect(requireApiUser(users)).rejects.toMatchObject({ status: 403 });
  });

  it('still needs the role: an admin-only route stays closed to a user whatever the scope', async () => {
    mockValidateToken.mockResolvedValue({
      token: {
        id: 1,
        name: 'scoped',
        createdBy: 7,
        createdAt: '',
        lastUsedAt: null,
        expiresAt: null,
        scope: 'custom',
        permissions: ['users:write'],
      },
      user: { id: 7, role: 'user', hasPassword: false, twoFactorEnabled: false },
    });
    const request = createMockRequest({ authorization: 'Bearer t', pathname: '/api/v1/users' });
    await expect(requireApiUser(request)).rejects.toMatchObject({ status: 403 });
  });
});

describe('authenticateApiRequest - empty bearer', () => {
  it('rejects empty Bearer token', async () => {
    await expect(
      authenticateApiRequest(createMockRequest({ authorization: 'Bearer ' })),
    ).rejects.toThrow(ApiAuthError);

    try {
      await authenticateApiRequest(createMockRequest({ authorization: 'Bearer ' }));
    } catch (e) {
      expect((e as ApiAuthError).status).toBe(401);
      expect((e as ApiAuthError).message).toBe('Invalid Bearer token');
    }
  });
});

describe('apiErrorResponse', () => {
  it('handles ApiAuthError', async () => {
    const response = apiErrorResponse(new ApiAuthError('Forbidden', 403));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Forbidden');
  });

  it('maps only an explicit NotFoundError to a safe 404', async () => {
    const response = apiErrorResponse(new NotFoundError('Token not found'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Token not found' });
  });

  it.each([
    [new ApiValidationError('Safe validation detail'), 400],
    [new ApiConflictError('Safe conflict detail'), 409],
  ])('returns explicitly client-safe errors without an error ID', async (error, status) => {
    const response = apiErrorResponse(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: error.message });
  });

  it('answers a DomainError that names its 4xx with that status and its English', async () => {
    const error = domainError('caCertificateInUse', { names: ['a', 'b'] }, { status: 409 });
    const response = apiErrorResponse(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'CA certificate is in use by proxy host(s): a, b',
    });
  });

  it('still redacts a DomainError with no status', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = apiErrorResponse(domainError('cannotDeleteOwnAccount'));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Internal server error');
    consoleSpy.mockRestore();
  });

  it('refuses a DomainError status outside 4xx', () => {
    expect(() => domainError('nameRequired', {}, { status: 500 })).toThrow(
      /status must be a 4xx status code/,
    );
  });

  it('prevents client-safe errors from being used to expose 5xx failures', () => {
    expect(() => new ApiClientError('must stay private', 500)).toThrow(
      /status must be a 4xx status code/,
    );
  });

  it('handles generic Error', async () => {
    const sensitiveMessage = 'Caddy at http://caddy:2019 failed: secret detail';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error(sensitiveMessage), {
      name: `Sensitive-${sensitiveMessage}`,
      code: `SECRET-${sensitiveMessage}`,
    });
    const response = apiErrorResponse(failure);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Internal server error');
    expect(data.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(data)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(sensitiveMessage);
    consoleSpy.mockRestore();
  });

  it('does not infer a safe 404 from an untyped internal error message', async () => {
    const response = apiErrorResponse(new Error('database table not found at /internal/path'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'Internal server error' });
  });

  it('preserves legacy model 404 semantics without reflecting model details', async () => {
    const response = apiErrorResponse(new Error('Sensitive tenant record not found'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
  });

  it('handles unknown error', async () => {
    const response = apiErrorResponse('some string error');
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Internal server error');
    expect(data.errorId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
