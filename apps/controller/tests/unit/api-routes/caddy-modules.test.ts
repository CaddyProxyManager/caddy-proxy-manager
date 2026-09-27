/**
 * PUT /api/v1/caddy/modules is a second write path into the module selection, so it must obey the
 * Settings UI's rules: refuse a selection disabling a module in use, regenerate the config on save.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

vi.mock('@/src/lib/settings', () => ({
  getCaddyBuildSettings: vi.fn().mockResolvedValue(null),
  saveCaddyBuildSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/lib/caddy-build', () => ({
  sanitizeCaddyBuildSettings: vi.fn((input: unknown) => input),
  getCaddyBuildDiff: vi.fn().mockResolvedValue({
    appliedSpecs: [],
    desiredSpecs: [],
    added: [],
    removed: [],
    needsRebuild: false,
  }),
}));

vi.mock('@/src/lib/caddy-build-conflicts', () => ({
  describeModuleConflicts: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/lib/api-auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
      this.name = 'ApiAuthError';
    }
  };
  return {
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      if (error instanceof ApiAuthError) {
        return NR.json({ error: error.message }, { status: error.status });
      }
      return NR.json({ error: (error as Error)?.message ?? 'error' }, { status: 500 });
    }),
    ApiAuthError,
  };
});

import { PUT } from '@/src/app/api/v1/caddy/modules/route';
import { describeModuleConflicts } from '@/src/lib/caddy-build-conflicts';
import { saveCaddyBuildSettings } from '@/src/lib/settings';
import { applyCaddyConfig } from '@/src/lib/caddy';

const mockConflicts = vi.mocked(describeModuleConflicts);
const mockSave = vi.mocked(saveCaddyBuildSettings);
const mockApply = vi.mocked(applyCaddyConfig);

function createMockRequest(body: unknown): any {
  return {
    headers: { get: () => null },
    method: 'PUT',
    nextUrl: { pathname: '/api/v1/caddy/modules', searchParams: new URLSearchParams() },
    json: async () => body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConflicts.mockResolvedValue(null);
});

describe('PUT /api/v1/caddy/modules', () => {
  it('saves the selection when nothing conflicts', async () => {
    const response = await PUT(createMockRequest({ modules: { 'caddy-l4': true } }));

    expect(response.status).toBe(200);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('refuses a selection that disables a module still in use', async () => {
    mockConflicts.mockResolvedValue(
      'Cannot disable those modules yet: 3 enabled L4 proxy hosts need the Layer 4 Proxy module.',
    );

    const response = await PUT(createMockRequest({ modules: { 'caddy-l4': false } }));
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toMatch(/Layer 4 Proxy module/);
    // The refusal must be total, not cosmetic.
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('regenerates the Caddy config after an accepted change', async () => {
    // Else the recreated container resumes a config naming a module the rebuild removed.
    await PUT(createMockRequest({ modules: { 'coraza-waf': false } }));

    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(
      mockApply.mock.invocationCallOrder[0],
    );
  });
});
