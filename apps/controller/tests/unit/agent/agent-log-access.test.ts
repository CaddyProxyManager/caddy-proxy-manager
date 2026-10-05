import { describe, expect, it } from 'bun:test';
import type { LogAccessReport } from '@cpm/shared';
import { logAccessFixes } from '../../../src/lib/agent/log-access';

function report(problems: LogAccessReport['problems'], overrides: Partial<LogAccessReport> = {}) {
  return {
    caddyContainer: 'caddy-proxy-manager-caddy',
    agentGroups: [10002, 10000, 10001],
    caddyGid: 10000,
    problems,
    ...overrides,
  } satisfies LogAccessReport;
}

describe('logAccessFixes', () => {
  it('has nothing to say about an agent that reported nothing', () => {
    expect(logAccessFixes(undefined)).toEqual([]);
    expect(logAccessFixes(report([]))).toEqual([]);
  });

  it("adds group write to an audit log in the agent's group", () => {
    const fixes = logAccessFixes(
      report([
        {
          kind: 'notTruncatable',
          path: '/logs/waf-audit.log',
          uid: 10000,
          gid: 10000,
          mode: 0o644,
        },
      ]),
    );
    expect(fixes).toEqual([
      {
        kind: 'notTruncatable',
        path: '/logs/waf-audit.log',
        gid: 10000,
        command: 'docker exec -u 0 caddy-proxy-manager-caddy chmod g+w /logs/waf-audit.log',
      },
    ]);
  });

  it('makes an unreadable log group-readable', () => {
    const [fix] = logAccessFixes(
      report([
        { kind: 'unreadable', path: '/logs/access.log', uid: 10000, gid: 10000, mode: 0o600 },
      ]),
    );
    expect(fix.command).toBe(
      'docker exec -u 0 caddy-proxy-manager-caddy chmod g+r /logs/access.log',
    );
  });

  // No mode helps a file whose group the agent is not in: the fix is CADDY_GID, once.
  it('collapses files in a foreign group into one CADDY_GID fix', () => {
    const fixes = logAccessFixes(
      report([
        { kind: 'unreadable', path: '/logs/access.log', uid: 1000, gid: 1000, mode: 0o640 },
        { kind: 'unreadable', path: '/logs/waf-rules.log', uid: 1000, gid: 1000, mode: 0o640 },
      ]),
    );
    expect(fixes).toEqual([
      {
        kind: 'groupMismatch',
        path: '/logs/access.log',
        gid: 1000,
        command: '# in .env: CADDY_GID=1000\ndocker compose up -d agent',
      },
    ]);
  });

  it("gives an unlistable directory caddy's group and a mode its roller can list", () => {
    const [fix] = logAccessFixes(
      report([{ kind: 'cleanupBlocked', path: '/logs', uid: 1000, gid: 1000, mode: 0o773 }]),
    );
    expect(fix.command).toBe(
      'docker exec -u 0 caddy-proxy-manager-caddy sh -c "chgrp 10000 /logs && chmod 2770 /logs"',
    );
  });

  it('quotes a path the shell would split', () => {
    const [fix] = logAccessFixes(
      report([
        { kind: 'unreadable', path: '/my logs/access.log', uid: 10000, gid: 10000, mode: 0o600 },
      ]),
    );
    expect(fix.command).toBe(
      "docker exec -u 0 caddy-proxy-manager-caddy chmod g+r '/my logs/access.log'",
    );
  });
});
