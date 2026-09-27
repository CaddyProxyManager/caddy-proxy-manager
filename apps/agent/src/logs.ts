/**
 * A file cursor is `<inode>:<offset>`, so a rotated file (new inode, or shorter than the offset)
 * starts again from its top rather than returning nothing forever. Caddy's own output is container
 * stderr, paged by timestamp.
 */
import { open, stat } from "node:fs/promises";
import type { LogReadRequest, LogReadResponse } from "@cpm/shared";
import { accessLogPath, wafRulesLogPath } from "./analytics/paths";

/** Caps one answer, which travels back as a single GraphQL mutation. */
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_LOG_LINES = 1000;
/** How far back a first page reaches in a file. */
const INITIAL_TAIL_BYTES = 64 * 1024;

function limitOf(request: LogReadRequest): number {
  const limit = Number(request.limit ?? 200);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LOG_LINES) : 200;
}

function parseFileCursor(cursor: unknown): { inode: number; offset: number } | null {
  if (typeof cursor !== "string") return null;
  const match = /^(\d+):(\d+)$/.exec(cursor);
  return match ? { inode: Number(match[1]), offset: Number(match[2]) } : null;
}

export async function readLogFile(path: string, request: LogReadRequest): Promise<LogReadResponse> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return { lines: [], cursor: null, missing: true };
  }
  const inode = Number(info.ino);
  const size = Number(info.size);
  const previous = parseFileCursor(request.cursor);

  let start: number;
  let dropFirst = false;
  if (!previous) {
    start = Math.max(0, size - INITIAL_TAIL_BYTES);
    // Starting mid-file lands mid-line; that fragment is dropped rather than shown garbled.
    dropFirst = start > 0;
  } else if (previous.inode !== inode || previous.offset > size) {
    start = 0;
  } else {
    start = previous.offset;
  }

  const length = Math.min(size - start, MAX_LOG_BYTES);
  if (length <= 0) return { lines: [], cursor: `${inode}:${start}` };

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Only whole lines: a half-written one is read again next time, once Caddy has finished it.
    const end = text.lastIndexOf("\n");
    if (end === -1) return { lines: [], cursor: `${inode}:${start}` };
    const limit = limitOf(request);
    let lines: string[] = [];
    let consumed = 0;
    for (const [index, line] of text.slice(0, end).split("\n").entries()) {
      // A later page stops at the limit, and the cursor stops with it, so nothing is skipped.
      if (previous && lines.length >= limit) break;
      consumed += Buffer.byteLength(line, "utf8") + 1;
      if (index === 0 && dropFirst) continue;
      if (line.trim()) lines.push(line);
    }
    // A first page shows the newest lines.
    if (!previous && lines.length > limit) lines = lines.slice(-limit);
    return {
      lines,
      cursor: `${inode}:${start + consumed}`,
      truncated: start + consumed < size,
    };
  } finally {
    await handle.close();
  }
}

export function logFileFor(source: LogReadRequest["source"]): string | null {
  if (source === "access") return accessLogPath();
  if (source === "waf") return wafRulesLogPath();
  return null;
}

/** A cursor for Caddy's output: the timestamp of the last line a page returned. */
export const CONTAINER_LOG_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** RFC 3339 with nanoseconds, as `docker logs --timestamps` prints before each line. */
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

/**
 * Parse `docker compose logs --timestamps` output. Lines at or before the cursor's timestamp are
 * ones the last page already had: `--since` includes its own boundary.
 */
export function parseContainerLogs(
  output: string,
  cursor: string | null,
  limit: number,
): LogReadResponse {
  const lines: string[] = [];
  let last = cursor;
  for (const raw of output.split("\n")) {
    const match = TIMESTAMP.exec(raw.trim());
    if (!match) continue;
    const [, stamp, line] = match;
    if (cursor && stamp <= cursor) continue;
    lines.push(line);
    last = stamp;
  }
  return { lines: lines.slice(-limit), cursor: last };
}
