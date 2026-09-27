/**
 * What an operator runs to fix the log permissions an agent reported; the agent cannot. Each fix
 * is a root `docker exec` in Caddy's container, which works on a named volume and a bind mount
 * alike.
 */

import type { LogAccessReport } from "@cpm/shared";

export type LogAccessFixKind = "groupMismatch" | "unreadable" | "notTruncatable" | "cleanupBlocked";

export type LogAccessFix = {
  kind: LogAccessFixKind;
  path: string;
  gid: number;
  command: string;
};

/** Quoted only when it has to be, so the common `/logs/access.log` reads as typed. */
function shellQuote(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One fix per problem, in the order reported, except that files whose group the agent is not in
 * collapse into one: that is a CADDY_GID mismatch, and no mode on the file would help.
 */
export function logAccessFixes(report: LogAccessReport | undefined): LogAccessFix[] {
  if (!report) return [];
  const container = shellQuote(report.caddyContainer);
  const exec = `docker exec -u 0 ${container}`;
  const fixes: LogAccessFix[] = [];
  const mismatched = new Set<number>();

  for (const problem of report.problems) {
    const path = shellQuote(problem.path);
    if (problem.kind === "cleanupBlocked") {
      const gid = report.caddyGid ?? problem.gid;
      fixes.push({
        kind: "cleanupBlocked",
        path: problem.path,
        gid,
        command: `${exec} sh -c "chgrp ${gid} ${path} && chmod 2770 ${path}"`,
      });
      continue;
    }

    if (!report.agentGroups.includes(problem.gid)) {
      if (mismatched.has(problem.gid)) continue;
      mismatched.add(problem.gid);
      fixes.push({
        kind: "groupMismatch",
        path: problem.path,
        gid: problem.gid,
        command: `# in .env: CADDY_GID=${problem.gid}\ndocker compose up -d agent`,
      });
      continue;
    }

    const bit = problem.kind === "unreadable" ? "g+r" : "g+w";
    fixes.push({
      kind: problem.kind,
      path: problem.path,
      gid: problem.gid,
      command: `${exec} chmod ${bit} ${path}`,
    });
  }

  return fixes;
}
