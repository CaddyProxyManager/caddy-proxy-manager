import { requireCan } from "@/src/lib/users/permissions";
import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { readAgentLog } from "@/src/lib/agent/client";
import type { LogSource } from "@/src/lib/analytics/log-view";

const SOURCES: readonly LogSource[] = ["access", "waf", "caddy"];

/**
 * Between reads of a log with nothing new, doubling while it stays quiet. Caddy's own log is a
 * `docker compose logs` spawn on the agent, not a file read, so a quiet tab backs off.
 */
const IDLE_MS = 750;
const MAX_IDLE_MS = 6000;
/** After a failed read, so a stopped agent is not asked every tick. */
const RETRY_MS = 3000;
const PAGE_LINES = 500;
const HEARTBEAT_MS = 20_000;

const encoder = new TextEncoder();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * The log viewer's feed, pushed instead of polled by every open tab. It reads the agent the same
 * way `/api/logs` does and sends only what is new; the frame's `id` is the cursor, so a reconnect
 * (which sends it back as Last-Event-ID) resumes rather than repeats. Admin only, like the page.
 */
export async function GET(request: NextRequest) {
  const t = await getTranslations("logs");
  await requireCan("logs:read");
  const params = request.nextUrl.searchParams;
  const agentId = params.get("agent") ?? "";
  const source = params.get("source") as LogSource;
  if (!agentId || !SOURCES.includes(source)) {
    return NextResponse.json({ error: t("readFailed") }, { status: 400 });
  }
  const resume = request.headers.get("last-event-id");
  let cursor: string | null = resume && resume.length > 0 ? resume : params.get("cursor");
  const signal = request.signal;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Closed by the client; the loop below sees the abort.
        }
      };
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      send("retry: 3000\n\n");
      let reported = false;
      let idle = IDLE_MS;

      try {
        while (!signal.aborted) {
          let wait = idle;
          try {
            const page = await readAgentLog(agentId, { source, cursor, limit: PAGE_LINES });
            if (page === null) {
              send(`event: problem\ndata: ${JSON.stringify({ error: t("agentCannotRead") })}\n\n`);
              wait = RETRY_MS;
            } else {
              const advanced = page.cursor !== null && page.cursor !== cursor;
              cursor = page.cursor ?? cursor;
              // The first frame always goes: it carries `missing` and the starting cursor.
              if (page.lines.length > 0 || advanced || !reported) {
                reported = true;
                // An opaque string from the agent; a line break in it would end the field.
                const id = cursor && !/[\r\n]/.test(cursor) ? `id: ${cursor}\n` : "";
                send(
                  `${id}event: lines\ndata: ${JSON.stringify({
                    lines: page.lines,
                    cursor,
                    missing: Boolean(page.missing),
                  })}\n\n`,
                );
              }
              // A full page means more is waiting.
              if (page.lines.length >= PAGE_LINES) wait = 0;
              idle = page.lines.length > 0 ? IDLE_MS : Math.min(idle * 2, MAX_IDLE_MS);
            }
          } catch {
            send(`event: problem\ndata: ${JSON.stringify({ error: t("readFailed") })}\n\n`);
            wait = RETRY_MS;
          }
          if (wait > 0) await sleep(wait, signal);
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
    },
  });
}
