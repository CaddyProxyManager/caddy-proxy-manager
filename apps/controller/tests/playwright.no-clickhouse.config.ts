import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  globalSetup: './global-setup.no-clickhouse.ts',
  globalTeardown: './global-teardown.no-clickhouse.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    storageState: resolve(moduleDir, '.auth/admin.json'),
    trace: 'on-first-retry',
    // The server's default, as on CI. Any other zone refreshes each fresh context once after
    // hydration, and on the portal that second render mints a second intent from a per-IP budget.
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
