import { describe, it, expect } from 'bun:test';
import { accessOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { NextRequest } from 'next/server';

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

import { GET } from '@/src/app/api/v1/openapi.json/route';

function makeRequest() {
  return new NextRequest('http://localhost/api/v1/openapi.json', {
    headers: { authorization: 'Bearer test-token' },
  });
}

describe('GET /api/v1/openapi.json', () => {
  it('returns 200', async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
  });

  it('returns valid JSON with openapi field = "3.1.0"', async () => {
    const response = await GET(makeRequest());
    const data = await response.json();
    expect(data.openapi).toBe('3.1.0');
  });

  it('contains all expected paths', async () => {
    const response = await GET(makeRequest());
    const data = await response.json();
    const paths = Object.keys(data.paths);

    expect(paths).toContain('/api/v1/tokens');
    expect(paths).toContain('/api/v1/proxy-hosts');
    expect(paths).toContain('/api/v1/l4-proxy-hosts');
    expect(paths).toContain('/api/v1/certificates');
    expect(paths).toContain('/api/v1/ca-certificates');
    expect(paths).toContain('/api/v1/client-certificates');
    expect(paths).toContain('/api/v1/access-lists');
    expect(paths).toContain('/api/v1/settings/{group}');
    expect(paths).toContain('/api/v1/users');
    expect(paths).toContain('/api/v1/audit-log');
    expect(paths).toContain('/api/v1/caddy/apply');
    expect(paths).toContain('/api/v1/dns-providers');
    expect(paths).toContain('/api/v1/proxy-hosts/{id}/mtls-access-rules/{ruleId}');
    expect(paths).toContain('/api/v1/client-certificates/{id}/roles');
  });

  it('has Cache-Control header', async () => {
    const response = await GET(makeRequest());
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=3600');
  });

  it('has components.schemas defined', async () => {
    const response = await GET(makeRequest());
    const data = await response.json();
    expect(data.components).toBeDefined();
    expect(data.components.schemas).toBeDefined();
    expect(Object.keys(data.components.schemas).length).toBeGreaterThan(0);
  });

  it('documents every role and status a user can have', async () => {
    const response = await GET(makeRequest());
    const user = (await response.json()).components.schemas.User.properties;
    expect(user.role.enum).toEqual(['admin', 'operator', 'user', 'viewer']);
    expect(user.status.enum).toEqual(['active', 'disabled']);
  });

  it('documents DNS credentials and certificate private keys as write-only', async () => {
    const response = await GET(makeRequest());
    const data = await response.json();

    const certificateOutput = data.components.schemas.Certificate.properties;
    const certificateInput = data.components.schemas.CertificateInput.properties;
    expect(certificateOutput.privateKeyPem).toBeUndefined();
    expect(certificateOutput.hasPrivateKey).toBeDefined();
    expect(certificateOutput.providerOptions.additionalProperties).toBe(false);
    expect(certificateInput.providerOptions.additionalProperties).toBe(false);
    expect(certificateInput.privateKeyPem).toBeDefined();
    expect(certificateInput.privateKeyPem.writeOnly).toBe(true);
    expect(data.components.schemas.CloudflareSettings.properties.apiToken.writeOnly).toBe(true);
    expect(
      data.components.schemas.DnsProviderSettings.properties.providers.additionalProperties
        .additionalProperties.writeOnly,
    ).toBe(true);

    const getSettingsSchemas =
      data.paths['/api/v1/settings/{group}'].get.responses['200'].content['application/json'].schema
        .oneOf;
    const putSettingsSchemas =
      data.paths['/api/v1/settings/{group}'].put.requestBody.content['application/json'].schema
        .oneOf;
    expect(getSettingsSchemas).toContainEqual({ $ref: '#/components/schemas/DnsProviderStatus' });
    expect(getSettingsSchemas).not.toContainEqual({
      $ref: '#/components/schemas/DnsProviderSettings',
    });
    expect(putSettingsSchemas).toContainEqual({ $ref: '#/components/schemas/DnsProviderSettings' });
    expect(getSettingsSchemas).toContainEqual({ $ref: '#/components/schemas/CloudflareStatus' });
    expect(getSettingsSchemas).not.toContainEqual({
      $ref: '#/components/schemas/CloudflareSettings',
    });
    expect(putSettingsSchemas).toContainEqual({ $ref: '#/components/schemas/CloudflareSettings' });
  });
});
