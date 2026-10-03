/**
 * E2E: every container in the test stack is running and healthy - catches permission errors,
 * missing dependencies, and Dockerfiles that make agents crash-loop.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ANALYTICS_OFF, COMPOSE_ARGS, COMPOSE_CWD } from '../helpers/compose';

type ContainerInfo = {
  name: string;
  /**
   * The compose service. Not the name: the project is caddy-proxy-manager, so
   * `name.includes('caddy')` matches every container in the stack.
   */
  service: string;
  state: string;
  health?: string;
};

function getContainers(): ContainerInfo[] {
  const output = execFileSync('docker', [...COMPOSE_ARGS, 'ps', '--format', 'json', '-a'], {
    cwd: COMPOSE_CWD,
    env: { ...process.env, CLICKHOUSE_PASSWORD: 'test-clickhouse-password-2026' },
    encoding: 'utf-8',
  });

  // docker compose ps --format json outputs one JSON object per line
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const c = JSON.parse(line);
      return {
        name: c.Name ?? c.Service,
        service: c.Service ?? '',
        state: (c.State ?? '').toLowerCase(),
        health: (c.Health ?? '').toLowerCase() || undefined,
      };
    });
}

test.describe('Container health', () => {
  let containers: ContainerInfo[];

  test.beforeAll(() => {
    containers = getContainers();
  });

  test('all containers are running', () => {
    expect(containers.length).toBeGreaterThan(0);
    for (const c of containers) {
      expect(c.state, `Container "${c.name}" is not running (state: ${c.state})`).toBe('running');
    }
  });

  test('web container is healthy', () => {
    const web = containers.find((c) => c.service === 'web');
    expect(web, 'web container not found').toBeTruthy();
    expect(web!.health, `web container health: ${web!.health}`).toBe('healthy');
  });

  test('caddy container is healthy', () => {
    const caddy = containers.find((c) => c.service === 'caddy');
    expect(caddy, 'caddy container not found').toBeTruthy();
    expect(caddy!.health, `caddy container health: ${caddy!.health}`).toBe('healthy');
  });

  test('clickhouse container is healthy', () => {
    test.skip(ANALYTICS_OFF, 'analytics is switched off in this run');
    const ch = containers.find((c) => c.service === 'clickhouse');
    expect(ch, 'clickhouse container not found').toBeTruthy();
    expect(ch!.health, `clickhouse container health: ${ch!.health}`).toBe('healthy');
  });

  test('no clickhouse container runs with analytics switched off', () => {
    test.skip(!ANALYTICS_OFF, 'analytics is on in this run');
    const ch = containers.find((c) => c.service === 'clickhouse');
    expect(ch, `ClickHouse is ${ch?.state} although analytics is off`).toBeUndefined();
  });

  test('agent container is running (not crash-looping)', () => {
    const agent = containers.find((c) => c.service === 'agent');
    expect(agent, 'agent container not found').toBeTruthy();
    expect(agent!.state, `agent state: ${agent!.state}`).toBe('running');

    // Verify it hasn't restarted (restart count > 0 means crash-loop)
    const inspect = execFileSync(
      'docker',
      ['inspect', '--format', '{{.RestartCount}}', agent!.name],
      {
        encoding: 'utf-8',
      },
    ).trim();
    const restartCount = Number(inspect);
    expect(restartCount, `agent has restarted ${restartCount} time(s) - likely crash-looping`).toBe(
      0,
    );
  });
});
