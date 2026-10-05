/**
 * Log permission checks, against stat results rather than a real filesystem: modes and owners are
 * the whole subject, and neither survives a Windows checkout.
 */
import { describe, expect, it } from "bun:test";
import {
  type FileInfo,
  findLogAccessProblems,
  parseIdentity,
  permissionsFor,
} from "../../src/analytics/log-access";

const CADDY = 10000;
const AGENT = { uid: 10002, groups: [10002, 10000, 10001] };
const PATHS = {
  dir: "/logs",
  access: "/logs/access.log",
  rules: "/logs/waf-rules.log",
  audit: "/logs/waf-audit.log",
};

function caddyFile(mode: number, gid = CADDY): FileInfo {
  return { uid: CADDY, gid, mode };
}

function statFrom(files: Record<string, FileInfo>) {
  return (path: string) => files[path] ?? null;
}

describe("permissionsFor", () => {
  it("uses the owner's bits for the owner, even when the group's are wider", () => {
    expect(permissionsFor({ uid: 1, groups: [5] }, { uid: 1, gid: 5, mode: 0o070 })).toEqual({
      read: false,
      write: false,
      execute: false,
    });
  });

  it("uses the group's bits for a member who does not own the file", () => {
    expect(permissionsFor({ uid: 2, groups: [5] }, { uid: 1, gid: 5, mode: 0o640 })).toEqual({
      read: true,
      write: false,
      execute: false,
    });
  });

  it("uses the other bits for everyone else", () => {
    expect(permissionsFor({ uid: 2, groups: [6] }, { uid: 1, gid: 5, mode: 0o773 })).toEqual({
      read: false,
      write: true,
      execute: true,
    });
  });

  it("gives root everything", () => {
    expect(permissionsFor({ uid: 0, groups: [0] }, { uid: 1, gid: 5, mode: 0 }).read).toBe(true);
  });
});

describe("findLogAccessProblems", () => {
  it("reports nothing for the modes the caddy image produces", () => {
    const { problems, caddyGid } = findLogAccessProblems(
      AGENT,
      PATHS,
      statFrom({
        "/logs": caddyFile(0o755),
        "/logs/access.log": caddyFile(0o640),
        "/logs/waf-rules.log": caddyFile(0o640),
        "/logs/waf-audit.log": caddyFile(0o660),
      }),
      true,
    );
    expect(problems).toEqual([]);
    expect(caddyGid).toBe(CADDY);
  });

  it("reports an audit log Coraza created itself as not truncatable", () => {
    const { problems } = findLogAccessProblems(
      AGENT,
      PATHS,
      statFrom({ "/logs": caddyFile(0o755), "/logs/waf-audit.log": caddyFile(0o644) }),
      true,
    );
    expect(problems).toEqual([
      { kind: "notTruncatable", path: "/logs/waf-audit.log", uid: CADDY, gid: CADDY, mode: 0o644 },
    ]);
  });

  it("reports a log in a group the agent is not in as unreadable", () => {
    const { problems } = findLogAccessProblems(
      AGENT,
      PATHS,
      statFrom({ "/logs": caddyFile(0o755), "/logs/access.log": caddyFile(0o640, 1234) }),
      true,
    );
    expect(problems.map((problem) => problem.kind)).toEqual(["unreadable"]);
  });

  it("ignores the files while the agent is not parsing them", () => {
    const { problems } = findLogAccessProblems(
      AGENT,
      PATHS,
      statFrom({ "/logs": caddyFile(0o755), "/logs/waf-audit.log": caddyFile(0o600) }),
      false,
    );
    expect(problems).toEqual([]);
  });

  // The incident upstream wrote up: a bind-mounted directory caddy could write but not list.
  it("reports a directory caddy can write but not list, whether or not the agent parses", () => {
    const { problems } = findLogAccessProblems(
      AGENT,
      PATHS,
      statFrom({
        "/logs": { uid: 1000, gid: 1000, mode: 0o773 },
        "/logs/access.log": caddyFile(0o640),
      }),
      false,
    );
    expect(problems).toEqual([
      { kind: "cleanupBlocked", path: "/logs", uid: 1000, gid: 1000, mode: 0o773 },
    ]);
  });

  it("does not guess at the directory before caddy has written anything", () => {
    const { problems, caddyGid } = findLogAccessProblems(
      AGENT,
      PATHS,
      statFrom({ "/logs": { uid: 1000, gid: 1000, mode: 0o773 } }),
      true,
    );
    expect(problems).toEqual([]);
    expect(caddyGid).toBeNull();
  });
});

describe("parseIdentity", () => {
  it("reads the effective uid, the primary gid and the supplementary groups", () => {
    const status = [
      "Name:\tcpm-agent",
      "Uid:\t10002\t10002\t10002\t10002",
      "Gid:\t10002\t10002\t10002\t10002",
      "Groups:\t10000 10001 ",
    ].join("\n");
    expect(parseIdentity(status)).toEqual({ uid: 10002, groups: [10002, 10000, 10001] });
  });

  it("handles a process with no supplementary groups", () => {
    expect(parseIdentity("Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t\n")).toEqual({
      uid: 0,
      groups: [0],
    });
  });

  it("returns null for anything that is not a status file", () => {
    expect(parseIdentity("")).toBeNull();
  });
});
