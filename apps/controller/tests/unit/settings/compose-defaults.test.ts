import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { SETTING_DEFINITIONS } from '@/src/lib/settings/registry';

/**
 * The registry holds every setting's default. One Compose sets as well reaches the container on
 * every deployment, so setup lists it as imported from the environment when nobody chose it.
 */

// Not the registry's default: the bundled stack reaches Caddy by another name.
const DEPLOYMENT_VALUES = new Set(['CADDY_API_URL']);

const compose = readFileSync(join(process.cwd(), '../../docker-compose.yml'), 'utf8');
const lines = compose.split('\n');
const start = lines.indexOf('  web:');
const end = lines.findIndex((line, i) => i > start && /^ {2}[a-z]/.test(line));
const web = lines.slice(start, end).join('\n');

describe('docker-compose.yml web.environment', () => {
  it('passes registry settings without a default', () => {
    const defaulted = (SETTING_DEFINITIONS as readonly { env: string }[])
      .filter(({ env }) => !DEPLOYMENT_VALUES.has(env))
      .filter(({ env }) => new RegExp(`\\$\\{${env}:-[^}]`).test(web))
      .map(({ env }) => env);
    expect(defaulted).toEqual([]);
  });
});
