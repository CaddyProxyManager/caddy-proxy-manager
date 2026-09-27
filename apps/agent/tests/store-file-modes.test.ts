/** The store holds each controller's secret in plaintext, so no one outside owner and group reads it. */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { AgentStore, restrictFileModes } from "../src/db";

// chmod only toggles read-only on Windows.
const posixIt = process.platform === "win32" ? it.skip : it;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-modes-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp directory is not worth failing a test over */
    }
  }
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("agent store file modes", () => {
  posixIt("removes world access and keeps owner and group bits", () => {
    const path = join(tempDir(), "agent.db");
    writeFileSync(path, "");
    chmodSync(path, 0o664);
    writeFileSync(`${path}-wal`, "");
    chmodSync(`${path}-wal`, 0o600);

    restrictFileModes(path);

    expect(modeOf(path)).toBe(0o660);
    expect(modeOf(`${path}-wal`)).toBe(0o600);
  });

  posixIt("leaves a new store unreadable to others", () => {
    const path = join(tempDir(), "agent.db");
    const store = new AgentStore(path);
    try {
      store.upsertController({ controllerId: "c1", controllerName: null, secret: "s" });
      expect(modeOf(path) & 0o007).toBe(0);
    } finally {
      store.close();
    }
  });

  it("ignores in-memory stores and missing files", () => {
    expect(() => restrictFileModes(":memory:")).not.toThrow();
    expect(() => restrictFileModes(join(tempDir(), "missing.db"))).not.toThrow();
  });
});
