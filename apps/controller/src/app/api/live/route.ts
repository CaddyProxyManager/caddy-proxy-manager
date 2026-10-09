import { type NextRequest, NextResponse } from "next/server";
import { requireCan } from "@/src/lib/users/permissions";
import { subscribeLive } from "@/src/lib/live/bus";
import { LIVE_TOPIC_CAPABILITY, type LiveTopic, isLiveTopic } from "@/src/lib/live/topics";

/** Under every proxy's idle timeout, and long enough that a quiet tab costs next to nothing. */
const HEARTBEAT_MS = 20_000;

const encoder = new TextEncoder();

/**
 * Server-sent events: `invalidate` per topic, never the data. A topic needs the capability its data
 * endpoint does, so a reader never learns that traffic moved on a page they cannot open. Session
 * only: an EventSource cannot send a bearer token.
 */
export async function GET(request: NextRequest) {
  const topics = [
    ...new Set((request.nextUrl.searchParams.get("topics") ?? "").split(",").filter(isLiveTopic)),
  ] as LiveTopic[];
  if (topics.length === 0) return NextResponse.json({ error: "No such topic" }, { status: 400 });
  try {
    for (const topic of topics) await requireCan(LIVE_TOPIC_CAPABILITY[topic]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const stops: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    for (const unsubscribe of stops.splice(0)) unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      send("retry: 3000\n\n");
      for (const topic of topics) {
        stops.push(
          subscribeLive(topic, () =>
            send(`event: invalidate\ndata: ${JSON.stringify({ topic })}\n\n`),
          ),
        );
      }
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      request.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      });
    },
    cancel: stop,
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform and an explicit encoding keep Caddy's encode handler from buffering the stream.
      "Cache-Control": "no-cache, no-store, no-transform",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
    },
  });
}
