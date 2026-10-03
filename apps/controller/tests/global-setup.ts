import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSE_ARGS, COMPOSE_CWD } from './helpers/compose';
import { waitForHydration } from './helpers/hydration';
import { signInWithCredentials } from './helpers/sign-in';

const moduleDir = dirname(fileURLToPath(import.meta.url));

const HEALTH_URL = 'http://localhost:3000/api/health';
export const AUTH_DIR = resolve(moduleDir, '.auth');
export const AUTH_FILE = resolve(AUTH_DIR, 'admin.json');
const MAX_WAIT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;
// docker-compose.yml requires SESSION_SECRET and .env is gitignored, so CI has none.
const ENV = {
  ...process.env,
  CLICKHOUSE_PASSWORD: 'test-clickhouse-password-2026',
  COMPOSE_PROFILES: 'clickhouse',
};

async function waitForHealth(): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < MAX_WAIT_MS) {
    attempt++;
    try {
      const res = await fetch(HEALTH_URL);
      if (res.status === 200) {
        console.log(`[global-setup] App is healthy (attempt ${attempt})`);
        return;
      }
      console.log(
        `[global-setup] Health check attempt ${attempt}: HTTP ${res.status}, retrying...`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[global-setup] Health check attempt ${attempt}: ${msg}, retrying in ${POLL_INTERVAL_MS / 1000}s...`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.error('[global-setup] Health check timed out. Container logs:');
  try {
    execFileSync('docker', [...COMPOSE_ARGS, 'logs', '--tail=50'], {
      stdio: 'inherit',
      cwd: COMPOSE_CWD,
      env: ENV,
    });
  } catch {
    /* ignore */
  }

  throw new Error(`App did not become healthy within ${MAX_WAIT_MS}ms`);
}

/**
 * Wait for Caddy to be healthy per Docker. The agent force-recreates caddy at startup
 * when an override file exists, and `docker compose up --wait` can return before that finishes.
 */
async function waitForCaddyHealthy(): Promise<void> {
  const start = Date.now();
  const maxWait = 90_000;
  console.log('[global-setup] Verifying Caddy is healthy...');
  while (Date.now() - start < maxWait) {
    const result = spawnSync(
      'docker',
      ['inspect', '--format={{.State.Health.Status}}', 'caddy-proxy-manager-caddy'],
      {
        encoding: 'utf-8',
        cwd: COMPOSE_CWD,
      },
    );
    if (result.status === 0 && result.stdout.trim() === 'healthy') {
      console.log('[global-setup] Caddy is healthy.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  console.warn('[global-setup] Caddy health wait timed out - proceeding anyway.');
}

async function seedAuthState(): Promise<void> {
  console.log('[global-setup] Seeding auth state via browser login...');
  mkdirSync(AUTH_DIR, { recursive: true });

  const browser = await chromium.launch();
  // As playwright.config's timezoneId: a zone cookie left in the saved state would refresh every
  // spec's first page after hydration.
  const page = await browser.newPage({ timezoneId: 'UTC' });

  try {
    await page.goto('http://localhost:3000/login');
    // Before hydration the form submits natively - a GET with the credentials in the query.
    await waitForHydration(page);
    await signInWithCredentials(page, 'testadmin', 'TestPassword2026!');

    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
    console.log(`[global-setup] Login succeeded, landed on: ${page.url()}`);

    await page.context().storageState({ path: AUTH_FILE });
    console.log('[global-setup] Auth state saved to', AUTH_FILE);
  } finally {
    await browser.close();
  }
}

export default async function globalSetup() {
  console.log('[global-setup] Starting Docker Compose test stack...');
  // Keycloak's first start, which imports its realm, is the slowest to turn healthy.
  execFileSync(
    'docker',
    [...COMPOSE_ARGS, 'up', '-d', '--build', '--wait', '--wait-timeout', '240'],
    {
      stdio: 'inherit',
      cwd: COMPOSE_CWD,
      env: ENV,
    },
  );

  console.log('[global-setup] Containers up. Waiting for /api/health...');
  await waitForHealth();
  await waitForCaddyHealthy();
  await seedAuthState();

  console.log('[global-setup] Done.');
}
