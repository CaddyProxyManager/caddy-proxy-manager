import { createReadStream } from "node:fs";

/** Per pass, so a backlog after downtime is drained over several rather than held in memory. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * The offset advances only past the last newline, so a half-written line is re-read next pass
 * rather than split. A missing file yields zero lines.
 */
export async function readLines(
  startOffset: number,
  file: string,
  maxBytes = MAX_READ_BYTES,
): Promise<{ lines: string[]; newOffset: number }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let totalBytes = 0; // all bytes read from startOffset to EOF
    let pending: Buffer = Buffer.alloc(0); // bytes after the last newline (incomplete line)

    const stream = createReadStream(file, { start: startOffset, end: startOffset + maxBytes - 1 });
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "EACCES")
        resolve({ lines: [], newOffset: startOffset });
      else reject(err);
    });
    stream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: hoisting it would call indexOf twice
      while ((nl = buf.indexOf(0x0a, start)) !== -1) {
        const line = buf.subarray(start, nl).toString("utf8").trim();
        if (line) lines.push(line);
        start = nl + 1;
      }
      pending = start === 0 ? buf : buf.subarray(start);
    });
    stream.on("end", () => {
      // A line longer than a whole pass would stall here forever: skip it.
      const skip = totalBytes >= maxBytes && lines.length === 0;
      resolve({ lines, newOffset: startOffset + totalBytes - (skip ? 0 : pending.length) });
    });
  });
}
