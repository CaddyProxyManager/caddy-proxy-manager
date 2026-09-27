import { describe, it, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The worker goes through `?worker&url` and setWorkerUrl(), since its own `import.meta.url` lookup
 * does not survive bundling. A renamed entry would otherwise be a silent blank map.
 */

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '../..');

const WORKER_SPECIFIER = 'maplibre-gl/dist/maplibre-gl-worker.mjs';

const worldMapInner = readFileSync(
  join(projectRoot, 'src', 'app', '(dashboard)', 'analytics', 'WorldMapInner.tsx'),
  'utf8',
);

describe('maplibre worker wiring', () => {
  it('resolves the worker entry maplibre-gl still ships', () => {
    expect(() => require.resolve(WORKER_SPECIFIER)).not.toThrow();
  });

  it('imports that worker through Vite so its sibling chunks get bundled in', () => {
    // It imports ./maplibre-gl-shared.mjs, which a bare `?url` copy would 404 on.
    expect(readFileSync(require.resolve(WORKER_SPECIFIER), 'utf8')).toContain(
      './maplibre-gl-shared.mjs',
    );
    // Quote-agnostic: the formatter's quoting is not the point.
    expect(worldMapInner.replace(/'/g, '"')).toContain(`"${WORKER_SPECIFIER}?worker&url"`);
  });

  it('points maplibre at the imported URL rather than a hardcoded path', () => {
    const setWorkerUrl = worldMapInner.match(/setWorkerUrl\(([^)]*)\)/);
    expect(setWorkerUrl?.[1]).toBe('maplibreWorkerUrl');
  });

  it('builds workers as ES modules, which maplibre requires', () => {
    // maplibre spawns a module worker, which Vite's iife default would break.
    const maplibre = readFileSync(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'), 'utf8');
    expect(maplibre.replace(/`/g, '"')).toContain('new Worker(e,{type:"module"})');

    const viteConfig = readFileSync(join(projectRoot, 'vite.config.ts'), 'utf8');
    expect(viteConfig.replace(/'/g, '"')).toMatch(/worker:\s*\{\s*format:\s*"es"/);
  });

  it("CSP allows loading the worker from 'self'", () => {
    const csp = readFileSync(join(projectRoot, 'src', 'lib', 'csp.ts'), 'utf8');
    const workerSrc = csp.match(/"worker-src ([^"]+)"/);
    expect(workerSrc?.[1]).toContain("'self'");
  });
});
