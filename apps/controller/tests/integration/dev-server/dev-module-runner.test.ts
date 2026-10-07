/**
 * The dev server rewrites dependencies' CommonJS before running them, so a package can bundle,
 * pass every unit test and still 500 every page under `bun run dev`. samlify's node-rsa did.
 * A subprocess, because this file's preload mocks would leak into the runner's external imports.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const controllerDir = resolve(import.meta.dir, '../../..');

// The auth server is on every page and pulls in each sign-in plugin's dependencies.
const MODULES = ['/src/lib/auth/server.ts'];

describe('the dev server module runner', () => {
  it(
    'loads the server modules every page imports',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'cpm-dev-runner-test-'));
      try {
        const child = Bun.spawn(
          [process.execPath, 'tests/helpers/dev-module-runner.ts', ...MODULES],
          {
            cwd: controllerDir,
            env: {
              ...process.env,
              NODE_ENV: 'development',
              // Its own throwaway database: importing the auth server opens one.
              DATABASE_URL: `file:${join(scratch, 'cpm.db')}`,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
        const results = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
        expect(results).toEqual(Object.fromEntries(MODULES.map((id) => [id, null])));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );
});
