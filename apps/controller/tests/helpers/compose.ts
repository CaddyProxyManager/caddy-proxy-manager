/**
 * The single definition of how the e2e stack is addressed on the docker CLI - six drifting copies
 * left two reading the developer's .env. `--env-file` REPLACES the repo-root .env, so a run is
 * the same with or without one; tests/e2e.env carries only what docker-compose.yml requires.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every docker command runs from here, not process.cwd(): Compose anchors relative paths to the
 * first `-f` file's directory, so build contexts and bind mounts stay on the repo root.
 */
export const COMPOSE_CWD = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const BASE_ARGS = [
  'compose',
  '--env-file',
  'apps/controller/tests/e2e.env',
  '-f',
  'docker-compose.yml',
  '-f',
  'apps/controller/tests/docker-compose.test.yml',
];

/**
 * One more `-f` when E2E_COMPOSE_EXTRA_FILE names it - CI's GitHub Actions layer cache, which
 * cannot live in the test override because `type=gha` needs credentials only a runner has.
 */
const EXTRA_FILE = process.env.E2E_COMPOSE_EXTRA_FILE;

export const COMPOSE_ARGS = EXTRA_FILE ? [...BASE_ARGS, '-f', EXTRA_FILE] : BASE_ARGS;

/**
 * Every profile the stack defines: `down` only touches active profiles, so Caddy (profile
 * `caddy`, started by the agent) would survive and hold its volumes, and the next run's agent
 * would resume a stale pairing and stop Caddy. A profile with no containers is a no-op.
 */
export const TEARDOWN_PROFILES = 'caddy,clickhouse,tools';
