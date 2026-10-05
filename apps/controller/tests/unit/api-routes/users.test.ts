import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

vi.mock('@/src/lib/models/user', () => ({
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  updateUserAccount: vi.fn(),
  updateUserRole: vi.fn(),
  updateUserStatus: vi.fn(),
  deleteUser: vi.fn(),
  createUser: vi.fn(),
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
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    requireApiUser: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
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

import { GET as listGET, POST as createPOST } from '@/src/app/api/v1/users/route';
import { GET as getGET, PUT } from '@/src/app/api/v1/users/[id]/route';
import {
  listUsers,
  getUserById,
  updateUserAccount,
  updateUserRole,
  updateUserStatus,
  createUser,
} from '@/src/lib/models/user';
import { requireApiAdmin, requireApiUser } from '@/src/lib/api/auth';

const mockListUsers = vi.mocked(listUsers);
const mockGetUserById = vi.mocked(getUserById);
const mockUpdateUserAccount = vi.mocked(updateUserAccount);
const mockRequireApiAdmin = vi.mocked(requireApiAdmin);
const mockRequireApiUser = vi.mocked(requireApiUser);

function createMockRequest(options: { method?: string; body?: unknown } = {}): any {
  return {
    headers: { get: () => null },
    method: options.method ?? 'GET',
    nextUrl: { pathname: '/api/v1/users', searchParams: new URLSearchParams() },
    json: async () => options.body ?? {},
  };
}

const sampleUser = {
  id: 1,
  name: 'Admin User',
  email: 'admin@example.com',
  role: 'admin',
  passwordHash: '$2b$10$hashedpassword',
  createdAt: '2026-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiAdmin.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' });
  mockRequireApiUser.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' });
});

describe('GET /api/v1/users', () => {
  it('returns list of users with passwordHash stripped', async () => {
    mockListUsers.mockResolvedValue([sampleUser] as any);

    const response = await listGET(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty('passwordHash');
    expect(data[0].name).toBe('Admin User');
    expect(data[0].email).toBe('admin@example.com');
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api/auth');
    mockRequireApiAdmin.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await listGET(createMockRequest());
    expect(response.status).toBe(401);
  });
});

describe('GET /api/v1/users/[id]', () => {
  it('returns a user by id with passwordHash stripped', async () => {
    mockGetUserById.mockResolvedValue(sampleUser as any);

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '1' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).not.toHaveProperty('passwordHash');
    expect(data.name).toBe('Admin User');
  });

  it('returns 404 for non-existent user', async () => {
    mockGetUserById.mockResolvedValue(null as any);

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '999' }) });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Not found');
  });

  it('returns 403 when non-admin tries to view another user', async () => {
    mockRequireApiUser.mockResolvedValue({ userId: 5, role: 'user', authMethod: 'bearer' });

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '1' }) });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Forbidden');
  });

  it('allows non-admin to view themselves', async () => {
    mockRequireApiUser.mockResolvedValue({ userId: 5, role: 'user', authMethod: 'bearer' });
    const user = { ...sampleUser, id: 5, role: 'user' };
    mockGetUserById.mockResolvedValue(user as any);

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '5' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(5);
    expect(data).not.toHaveProperty('passwordHash');
  });
});

describe('PUT /api/v1/users/[id]', () => {
  it('updates a user profile', async () => {
    const body = { name: 'Updated Name' };
    const updated = { ...sampleUser, name: 'Updated Name' };
    mockUpdateUserAccount.mockResolvedValue({ user: updated, previousUsername: null } as any);
    mockGetUserById.mockResolvedValue(updated as any);

    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ id: '1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.name).toBe('Updated Name');
    expect(data).not.toHaveProperty('passwordHash');
    expect(mockUpdateUserAccount).toHaveBeenCalledWith(1, { name: 'Updated Name' });
  });

  it('returns 404 when updating non-existent user', async () => {
    mockGetUserById.mockResolvedValue(null as any);

    const response = await PUT(createMockRequest({ method: 'PUT', body: { name: 'X' } }), {
      params: Promise.resolve({ id: '999' }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Not found');
  });
});

describe('PUT /api/v1/users/[id] role and status', () => {
  const put = (body: unknown) =>
    PUT(createMockRequest({ method: 'PUT', body }), { params: Promise.resolve({ id: '2' }) });

  it('refuses a role outside the allowlist rather than silently ignoring it', async () => {
    mockGetUserById.mockResolvedValue({ ...sampleUser, id: 2 } as any);

    const response = await put({ role: 'superadmin' });

    expect(response.status).toBe(400);
    expect(vi.mocked(updateUserRole)).not.toHaveBeenCalled();
  });

  it('assigns the operator role, which the dashboard offers too', async () => {
    mockGetUserById.mockResolvedValue({ ...sampleUser, id: 2, role: 'operator' } as any);

    const response = await put({ role: 'operator' });

    expect(response.status).toBe(200);
    expect(vi.mocked(updateUserRole)).toHaveBeenCalledWith(2, 'operator');
  });

  it('refuses an unknown status', async () => {
    mockGetUserById.mockResolvedValue({ ...sampleUser, id: 2 } as any);

    const response = await put({ status: 'banned' });

    expect(response.status).toBe(400);
    expect(vi.mocked(updateUserStatus)).not.toHaveBeenCalled();
  });

  it('refuses an email that cannot be an address, before writing anything', async () => {
    mockGetUserById.mockResolvedValue({ ...sampleUser, id: 2 } as any);

    const response = await put({ role: 'viewer', email: 'not an email' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('valid email address');
    expect(vi.mocked(updateUserRole)).not.toHaveBeenCalled();
    expect(mockUpdateUserAccount).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/users', () => {
  it('holds a password an administrator chooses to the password policy', async () => {
    const response = await createPOST(
      createMockRequest({
        method: 'POST',
        body: { email: 'new@example.com', password: 'password' },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('at least 12 characters');
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });

  it('refuses an email that cannot be an address', async () => {
    const response = await createPOST(
      createMockRequest({
        method: 'POST',
        body: { email: 'new@', password: 'CorrectHorse2026!' },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('valid email address');
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });

  it('creates a user whose password passes', async () => {
    vi.mocked(createUser).mockResolvedValue({ ...sampleUser, id: 3 } as any);

    const response = await createPOST(
      createMockRequest({
        method: 'POST',
        body: { email: 'new@example.com', password: 'CorrectHorse2026!', role: 'viewer' },
      }),
    );

    expect(response.status).toBe(201);
    expect(vi.mocked(createUser)).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com', role: 'viewer' }),
    );
  });
});

describe('PUT /api/v1/users/[id] email and username', () => {
  const put = (body: unknown) =>
    PUT(createMockRequest({ method: 'PUT', body }), { params: Promise.resolve({ id: '2' }) });

  it('trims the email before storing it', async () => {
    mockUpdateUserAccount.mockResolvedValue({ user: sampleUser, previousUsername: null } as any);
    mockGetUserById.mockResolvedValue({ ...sampleUser, id: 2 } as any);

    const response = await put({ email: '  new@example.com  ' });

    expect(response.status).toBe(200);
    expect(mockUpdateUserAccount).toHaveBeenCalledWith(2, { email: 'new@example.com' });
  });

  it('refuses a username that is not a string before writing anything', async () => {
    const response = await put({ username: 42, role: 'viewer' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('lowercase letters');
    expect(mockUpdateUserAccount).not.toHaveBeenCalled();
    expect(vi.mocked(updateUserRole)).not.toHaveBeenCalled();
  });

  it('treats a null username as no change', async () => {
    mockUpdateUserAccount.mockResolvedValue({ user: sampleUser, previousUsername: null } as any);
    mockGetUserById.mockResolvedValue({ ...sampleUser, id: 2 } as any);

    const response = await put({ username: null, name: 'Changed' });

    expect(response.status).toBe(200);
    expect(mockUpdateUserAccount).toHaveBeenCalledWith(2, { name: 'Changed' });
  });
});

describe('POST /api/v1/users username', () => {
  it('passes an explicit username to the model', async () => {
    vi.mocked(createUser).mockResolvedValue({ ...sampleUser, id: 3 } as any);

    const response = await createPOST(
      createMockRequest({
        method: 'POST',
        body: { email: 'new@example.com', password: 'CorrectHorse2026!', username: 'newbie' },
      }),
    );

    expect(response.status).toBe(201);
    expect(vi.mocked(createUser)).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com', username: 'newbie' }),
    );
  });

  it('refuses a username that is not a string', async () => {
    const response = await createPOST(
      createMockRequest({
        method: 'POST',
        body: { email: 'new@example.com', password: 'CorrectHorse2026!', username: 7 },
      }),
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });
});
