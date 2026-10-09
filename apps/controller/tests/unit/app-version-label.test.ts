import { describe, expect, it } from 'bun:test';
import { appVersionLabel } from '@/src/lib/runtime/app-version';

describe('appVersionLabel', () => {
  it('is the given version label under the product name', () => {
    expect(appVersionLabel('Caddy Proxy Manager', 'Version 3.8.0', '3.8.0')).toBe('Version 3.8.0');
    expect(appVersionLabel(' Caddy Proxy Manager ', 'Version 3.8.0', '3.8.0')).toBe(
      'Version 3.8.0',
    );
  });

  it('names the product beside the version under a custom name', () => {
    expect(appVersionLabel('Acme Edge', 'Version 3.8.0', '3.8.0')).toBe(
      'Caddy Proxy Manager v3.8.0',
    );
  });
});
