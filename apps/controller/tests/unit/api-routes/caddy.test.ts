import { describe, it, expect, beforeEach } from 'bun:test';
import { accessOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';

vi.mock('@/src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/src/lib/api/auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
      this.name = 'ApiAuthError';
    }
  };
  return {
    requireApiUser: vi.fn().mockResolvedValue({
      userId: 1,
      role: 'admin',
      authMethod: 'bearer',
      access: accessOf('admin'),
    }),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      if (error instanceof ApiAuthError) {
        return NR.json({ error: error.message }, { status: error.status });
      }
      return NR.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 },
      );
    }),
    ApiAuthError,
  };
});

import { POST } from '@/src/app/api/v1/caddy/apply/route';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { requireApiUser } from '@/src/lib/api/auth';

const mockApplyCaddyConfig = vi.mocked(applyCaddyConfig);
const mockRequireApiUser = vi.mocked(requireApiUser);

function createMockRequest(): any {
  return {
    headers: { get: () => null },
    method: 'POST',
    nextUrl: { pathname: '/api/v1/caddy/apply', searchParams: new URLSearchParams() },
    json: async () => ({}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiUser.mockResolvedValue({
    userId: 1,
    role: 'admin',
    authMethod: 'bearer',
    access: accessOf('admin'),
  });
  mockApplyCaddyConfig.mockResolvedValue(undefined);
});

describe('POST /api/v1/caddy/apply', () => {
  it('applies caddy config and returns ok', async () => {
    const response = await POST(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api/auth');
    mockRequireApiUser.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await POST(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 500 when applyCaddyConfig fails', async () => {
    mockApplyCaddyConfig.mockRejectedValue(new Error('Connection refused'));

    const response = await POST(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Connection refused');
  });
});
