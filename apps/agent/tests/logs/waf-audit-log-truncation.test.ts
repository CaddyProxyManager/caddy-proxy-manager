/**
 * Regression: Coraza never rotates waf-audit.log, which grew to ~2GB. A real store on a temp file,
 * since a test spanning two passes proves nothing if each starts from a blank slate.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { vi } from "../helpers/vi";

// Matches AUDIT_LOG_TRUNCATE_THRESHOLD in src/analytics/waf-log-parser.ts
const TRUNCATE_THRESHOLD = 100 * 1024 * 1024;
const AUDIT_LOG_PATH = "/logs/waf-audit.log";

const fsState = { auditSize: 0, rulesExists: false, auditInode: 42 };

vi.mock("node:fs", () => ({
  existsSync: vi.fn((p: string) => (p.includes("waf-audit") ? true : fsState.rulesExists)),
  statSync: vi.fn((p: string) => ({
    size: p.includes("waf-audit") ? fsState.auditSize : 0,
    ino: p.includes("waf-audit") ? fsState.auditInode : 1,
  })),
  // Exactly `size - start` bytes, to EOF in one pass. Buffers, as createReadStream yields with no
  // encoding, because the offsets count bytes, not characters.
  createReadStream: vi.fn((p: string, opts: { start?: number }) => {
    const start = opts?.start ?? 0;
    const size = p.includes("waf-audit") ? fsState.auditSize : 0;
    const remaining = Math.max(0, size - start);
    const content =
      remaining > 0
        ? `${"x".repeat(remaining - 1)}
`
        : "";
    return Readable.from([Buffer.from(content, "utf8")]);
  }),
  truncateSync: vi.fn(),
  // The store creates its directory and opens a database; those calls are real.
  mkdirSync: vi.fn(),
}));

import * as fs from "node:fs";
import { AgentStore } from "../../src/db";
import { bindStore, parseNewWafLogEntries } from "../../src/analytics/waf-log-parser";

let dir: string;
let store: AgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-waf-"));
  store = new AgentStore(join(dir, "agent.db"));
  bindStore(store);

  fsState.auditSize = 0;
  fsState.rulesExists = false;
  fsState.auditInode = 42;
  vi.mocked(fs.truncateSync).mockReset();
});

afterEach(() => {
  store.close();
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* not worth failing a test over */
  }
});

function stateValue(key: string): string | undefined {
  return store.parseState(key) ?? undefined;
}

describe("waf-audit.log truncation", () => {
  it("does not truncate when below the size threshold", async () => {
    fsState.auditSize = 50 * 1024 * 1024; // 50MB < 100MB threshold
    await parseNewWafLogEntries();

    expect(fs.truncateSync).not.toHaveBeenCalled();
    expect(stateValue("waf_audit_log_size")).toBe(String(fsState.auditSize));
  });

  it("does not truncate exactly at the threshold (strictly greater-than)", async () => {
    fsState.auditSize = TRUNCATE_THRESHOLD;
    await parseNewWafLogEntries();

    expect(fs.truncateSync).not.toHaveBeenCalled();
    expect(stateValue("waf_audit_log_size")).toBe(String(TRUNCATE_THRESHOLD));
  });

  it("truncates in place once past the threshold and resets stored offset/size to 0", async () => {
    fsState.auditSize = TRUNCATE_THRESHOLD + 1;
    await parseNewWafLogEntries();

    expect(fs.truncateSync).toHaveBeenCalledWith(AUDIT_LOG_PATH, 0);
    expect(stateValue("waf_audit_log_offset")).toBe("0");
    expect(stateValue("waf_audit_log_size")).toBe("0");
  });

  // #233: the file is 0644 as caddy, so another UID gets EACCES on truncate. That must not abort
  // the pass before the offsets persist, or every later pass re-inserts the same tail.
  it("keeps advancing the stored offset when truncation fails with EACCES", async () => {
    fsState.auditSize = TRUNCATE_THRESHOLD + 1;
    vi.mocked(fs.truncateSync).mockImplementation(() => {
      const err = new Error(
        "EACCES: permission denied, truncate '/logs/waf-audit.log'",
      ) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    await parseNewWafLogEntries();

    expect(fs.truncateSync).toHaveBeenCalled();
    expect(stateValue("waf_audit_log_offset")).toBe(String(fsState.auditSize));
    expect(stateValue("waf_audit_log_size")).toBe(String(fsState.auditSize));
  });

  it("re-reads from the start when the audit log is replaced by a new inode", async () => {
    // First pass consumes the whole file and records its inode.
    fsState.auditSize = 5_000;
    await parseNewWafLogEntries();
    expect(stateValue("waf_audit_log_offset")).toBe("5000");

    // Recreated and grown past the stored size, so only the inode reveals the replacement.
    fsState.auditInode = 43;
    fsState.auditSize = 9_000;
    await parseNewWafLogEntries();

    // Read restarted at 0, so the offset reflects the full new file.
    expect(stateValue("waf_audit_log_offset")).toBe("9000");
    expect(stateValue("waf_audit_log_inode")).toBe("43");
  });
});
