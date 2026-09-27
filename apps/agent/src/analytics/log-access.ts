/**
 * The agent reads Caddy's logs through Caddy's group, and every way that breaks is silent (an
 * empty parse, a growing audit log, a roller that stops pruning). So this warns once per problem
 * and reports it for the Agents page. It never changes a permission.
 */

import { readFileSync, statSync } from "node:fs";
import type { LogAccessProblem, LogAccessReport } from "@cpm/shared";
import { accessLogPath, logsDir, wafAuditLogPath, wafRulesLogPath } from "./paths";

export type Identity = { uid: number; groups: number[] };
export type FileInfo = { uid: number; gid: number; mode: number };
export type Permissions = { read: boolean; write: boolean; execute: boolean };

/** As the kernel picks: owner's, else group's, else other's bits. Never a union of the three. */
export function permissionsFor(who: Identity, file: FileInfo): Permissions {
  if (who.uid === 0) return { read: true, write: true, execute: true };
  const shift = file.uid === who.uid ? 6 : who.groups.includes(file.gid) ? 3 : 0;
  const bits = (file.mode >> shift) & 0o7;
  return { read: (bits & 0o4) !== 0, write: (bits & 0o2) !== 0, execute: (bits & 0o1) !== 0 };
}

export type LogPaths = { dir: string; access: string; rules: string; audit: string };

/**
 * `checkFiles`: whether the agent parses the logs at all; the directory matters either way.
 * Caddy's identity comes off its files, as the build argument that sets it is invisible here.
 */
export function findLogAccessProblems(
  agent: Identity,
  paths: LogPaths,
  stat: (path: string) => FileInfo | null,
  checkFiles: boolean,
): { problems: LogAccessProblem[]; caddyGid: number | null } {
  const problems: LogAccessProblem[] = [];
  const access = stat(paths.access);
  const rules = stat(paths.rules);
  const audit = stat(paths.audit);

  if (checkFiles) {
    for (const [path, file] of [
      [paths.access, access],
      [paths.rules, rules],
    ] as const) {
      if (file && !permissionsFor(agent, file).read)
        problems.push({ kind: "unreadable", path, ...file });
    }
    if (audit) {
      const allowed = permissionsFor(agent, audit);
      if (!allowed.read) problems.push({ kind: "unreadable", path: paths.audit, ...audit });
      else if (!allowed.write)
        problems.push({ kind: "notTruncatable", path: paths.audit, ...audit });
    }
  }

  const owned = access ?? rules ?? audit;
  const caddy = owned ? { uid: owned.uid, groups: [owned.gid] } : null;
  const dir = stat(paths.dir);
  if (caddy && dir) {
    const allowed = permissionsFor(caddy, dir);
    if (allowed.write && allowed.execute && !allowed.read) {
      problems.push({ kind: "cleanupBlocked", path: paths.dir, ...dir });
    }
  }

  return { problems, caddyGid: owned?.gid ?? null };
}

/** From procfs: Bun has neither `process.getuid` nor `process.getgroups`. Null off Linux. */
export function parseIdentity(status: string): Identity | null {
  const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1];
  const uid = field("Uid")?.split(/\s+/)[1];
  const gid = field("Gid")?.split(/\s+/)[1];
  if (uid === undefined || gid === undefined) return null;
  const groups = (field("Groups") ?? "").split(/\s+/).filter(Boolean).map(Number);
  return { uid: Number(uid), groups: [...new Set([Number(gid), ...groups])] };
}

function readIdentity(): Identity | null {
  try {
    return parseIdentity(readFileSync("/proc/self/status", "utf-8"));
  } catch {
    return null;
  }
}

function statFile(path: string): FileInfo | null {
  try {
    const { uid, gid, mode } = statSync(path);
    return { uid, gid, mode: mode & 0o7777 };
  } catch {
    return null;
  }
}

/** So each problem logs once, not every status heartbeat. */
const warned = new Set<string>();

function describe(problem: LogAccessProblem): string {
  const owner = `owner ${problem.uid}:${problem.gid}, mode ${problem.mode.toString(8).padStart(4, "0")}`;
  switch (problem.kind) {
    case "unreadable":
      return `cannot read ${problem.path} (${owner}), so its events are not being recorded.`;
    case "notTruncatable":
      return `cannot write ${problem.path} (${owner}), so it cannot be truncated once ingested and will keep growing.`;
    case "cleanupBlocked":
      return (
        `Caddy can write ${problem.path} but not list it (${owner}), so rolled logs are never ` +
        "compressed or deleted and will fill the disk."
      );
  }
}

/** Undefined when this process cannot tell who it is: every answer would be a guess. */
export function checkLogAccess(
  caddyContainer: string,
  parsing: boolean,
): LogAccessReport | undefined {
  const agent = readIdentity();
  if (!agent) return undefined;

  const paths = {
    dir: logsDir(),
    access: accessLogPath(),
    rules: wafRulesLogPath(),
    audit: wafAuditLogPath(),
  };
  const { problems, caddyGid } = findLogAccessProblems(agent, paths, statFile, parsing);

  const current = new Set(problems.map((problem) => `${problem.kind}:${problem.path}`));
  for (const problem of problems) {
    const key = `${problem.kind}:${problem.path}`;
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(
      `[log-access] ${describe(problem)} The Agents page shows the command that fixes it.`,
    );
  }
  for (const key of warned) {
    if (!current.has(key)) warned.delete(key);
  }

  return { caddyContainer, agentGroups: agent.groups, caddyGid, problems };
}
