import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContainerLogs, readLogFile } from "../src/logs";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cpm-logs-"));
  file = join(dir, "access.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = (from: number, to: number) =>
  `${Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n")}\n`;

describe("readLogFile", () => {
  it("says so when the log does not exist", async () => {
    expect(await readLogFile(file, { source: "access" })).toMatchObject({
      lines: [],
      missing: true,
    });
  });

  it("starts with the newest lines, then continues from where it stopped", async () => {
    writeFileSync(file, lines(1, 50));
    const first = await readLogFile(file, { source: "access", limit: 10 });
    expect(first.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line ${41 + i}`));

    appendFileSync(file, lines(51, 53));
    const next = await readLogFile(file, { source: "access", cursor: first.cursor });
    expect(next.lines).toEqual(["line 51", "line 52", "line 53"]);
  });

  it("leaves a half-written line for the next page", async () => {
    writeFileSync(file, "line 1\nline 2");
    const first = await readLogFile(file, { source: "access" });
    expect(first.lines).toEqual(["line 1"]);
    appendFileSync(file, " done\n");
    expect((await readLogFile(file, { source: "access", cursor: first.cursor })).lines).toEqual([
      "line 2 done",
    ]);
  });

  it("does not skip what a limited page left behind", async () => {
    writeFileSync(file, lines(1, 2));
    const first = await readLogFile(file, { source: "access" });
    appendFileSync(file, lines(3, 12));
    const page = await readLogFile(file, { source: "access", cursor: first.cursor, limit: 4 });
    expect(page.lines).toEqual(["line 3", "line 4", "line 5", "line 6"]);
    expect(page.truncated).toBe(true);
    const rest = await readLogFile(file, { source: "access", cursor: page.cursor, limit: 100 });
    expect(rest.lines[0]).toBe("line 7");
  });

  it("starts a rotated file from its top", async () => {
    writeFileSync(file, lines(1, 20));
    const first = await readLogFile(file, { source: "access" });
    rmSync(file);
    writeFileSync(file, lines(100, 101));
    const next = await readLogFile(file, { source: "access", cursor: first.cursor });
    expect(next.lines).toEqual(["line 100", "line 101"]);
  });
});

describe("parseContainerLogs", () => {
  const output = [
    '2026-09-26T10:00:00.000000001Z {"level":"info","msg":"one"}',
    '2026-09-26T10:00:01.000000000Z {"level":"info","msg":"two"}',
    "not a log line",
  ].join("\n");

  it("keeps each line after its timestamp, and moves the cursor to the last", () => {
    const page = parseContainerLogs(output, null, 100);
    expect(page.lines).toEqual(['{"level":"info","msg":"one"}', '{"level":"info","msg":"two"}']);
    expect(page.cursor).toBe("2026-09-26T10:00:01.000000000Z");
  });

  it("drops what the last page already had: --since includes its own boundary", () => {
    const page = parseContainerLogs(output, "2026-09-26T10:00:00.000000001Z", 100);
    expect(page.lines).toEqual(['{"level":"info","msg":"two"}']);
  });
});

describe("CONTAINER_LOG_CURSOR", () => {
  it("takes a docker timestamp and nothing that could read as a flag", async () => {
    const { CONTAINER_LOG_CURSOR } = await import("../src/logs");
    expect(CONTAINER_LOG_CURSOR.test("2026-09-26T10:00:01.000000000Z")).toBe(true);
    for (const bad of ["--help", "-1h", "2026-09-26 10:00:01", "2026-09-26T10:00:01Z --x"]) {
      expect(CONTAINER_LOG_CURSOR.test(bad)).toBe(false);
    }
  });
});
