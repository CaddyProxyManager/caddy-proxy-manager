/**
 * POST /api/user/update-avatar stores the image inline on the user row, sent with every page
 * that shows it, so the cap is sized for an icon.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '../../helpers/next-intl';

vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('@/src/lib/models/user', () => ({
  getUserById: vi.fn(),
  updateUserProfile: vi.fn(),
}));
vi.mock('@/src/lib/models/audit', () => ({ createAuditEvent: vi.fn() }));

import type { NextRequest } from 'next/server';
import { POST } from '@/src/app/api/user/update-avatar/route';
import { updateUserProfile } from '@/src/lib/models/user';
import { MAX_AVATAR_DATA_URL_LENGTH, MAX_AVATAR_FILE_KB } from '@/src/lib/users/avatar-limits';

const mockUpdateUserProfile = vi.mocked(updateUserProfile);
const PNG_PREFIX = 'data:image/png;base64,';

/** A same-origin POST, shaped by hand: a real Request drops the Host header checkSameOrigin reads. */
function post(body: unknown) {
  return POST({
    method: 'POST',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'origin' ? 'http://localhost:3000' : 'localhost:3000',
    },
    json: async () => body,
  } as unknown as NextRequest);
}

beforeEach(() => {
  mockUpdateUserProfile.mockReset();
  mockUpdateUserProfile.mockResolvedValue({ avatarUrl: 'stored' } as any);
});

describe('POST /api/user/update-avatar', () => {
  it('refuses an image over the cap and stores nothing', async () => {
    const response = await post({ avatarUrl: PNG_PREFIX + 'A'.repeat(MAX_AVATAR_DATA_URL_LENGTH) });

    expect(response.status).toBe(400);
    expect(mockUpdateUserProfile).not.toHaveBeenCalled();
  });

  it('accepts a file at the size the profile page allows', async () => {
    // Base64 is 4/3 of the bytes; the page's limit has to fit under the route's.
    const encodedLength = PNG_PREFIX.length + Math.ceil((MAX_AVATAR_FILE_KB * 1024) / 3) * 4;
    expect(encodedLength).toBeLessThanOrEqual(MAX_AVATAR_DATA_URL_LENGTH);

    const response = await post({
      avatarUrl: PNG_PREFIX + 'A'.repeat(encodedLength - PNG_PREFIX.length),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateUserProfile).toHaveBeenCalled();
  });

  it('still refuses a data URL that is not an image', async () => {
    const response = await post({ avatarUrl: 'data:text/html;base64,PHNjcmlwdD4=' });

    expect(response.status).toBe(400);
    expect(mockUpdateUserProfile).not.toHaveBeenCalled();
  });
});
