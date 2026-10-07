/**
 * Imports modules through the vinext dev server's RSC module runner, the way `bun run dev` loads
 * a page, and prints `{ module: error | null }` as JSON. Run with `bun`, cwd apps/controller.
 * Dev rewrites dependencies' CommonJS, so a package that bundles and unit-tests cleanly can still
 * throw here (node-rsa's circular require did, on every page).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, isRunnableDevEnvironment } from 'vite';

const modules = process.argv.slice(2);
const root = resolve(import.meta.dir, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'cpm-dev-runner-'));

const server = await createServer({
  root,
  // Its own optimizer cache: a dev server already running in this checkout keeps the shared one.
  cacheDir: join(scratch, 'vite'),
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [
    {
      // vinext runs register() on startup, which would migrate a database and apply Caddy.
      name: 'cpm:skip-instrumentation',
      enforce: 'pre',
      load(id) {
        if (/[\\/]src[\\/]instrumentation\.ts$/.test(id.split('?')[0])) return 'export {};';
      },
    },
  ],
});

const results: Record<string, string | null> = {};
try {
  const rsc = server.environments.rsc;
  if (!isRunnableDevEnvironment(rsc)) throw new Error('the rsc environment is not runnable');
  for (const id of modules) {
    try {
      await rsc.runner.import(id);
      results[id] = null;
    } catch (error) {
      results[id] =
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    }
  }
} finally {
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify(results));
process.exit(0);
