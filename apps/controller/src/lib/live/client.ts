/**
 * One EventSource per tab, however many views listen: browsers cap connections per origin, and a
 * page with a chart, a table and a banner would otherwise hold three. The set of topics is the
 * union of what is mounted, and the stream is reopened when it changes.
 */

import { type LiveTopic, isLiveTopic } from "./topics";

type Handler = () => void;
type StatusListener = (connected: boolean) => void;

const handlers = new Map<LiveTopic, Set<Handler>>();
const statusListeners = new Set<StatusListener>();

let source: EventSource | null = null;
let openedFor = "";
let connected = false;
let everOpened = false;

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of statusListeners) listener(connected);
}

function topicKey(): string {
  return [...handlers.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([topic]) => topic)
    .sort()
    .join(",");
}

function fire(topic: LiveTopic): void {
  for (const handler of handlers.get(topic) ?? []) handler();
}

function reconcile(): void {
  const key = topicKey();
  if (key === openedFor) return;
  source?.close();
  source = null;
  openedFor = key;
  setConnected(false);
  if (!key || typeof EventSource === "undefined") return;

  const next = new EventSource(`/api/live?topics=${key}`);
  source = next;
  next.addEventListener("open", () => {
    setConnected(true);
    // Whatever arrived while it was down was never announced to this tab: read it all again.
    if (everOpened) for (const topic of handlers.keys()) fire(topic);
    everOpened = true;
  });
  next.addEventListener("invalidate", (event) => {
    try {
      const { topic } = JSON.parse((event as MessageEvent<string>).data) as { topic?: string };
      if (topic && isLiveTopic(topic)) fire(topic);
    } catch {
      // A malformed frame is skipped; the next one still arrives.
    }
  });
  next.addEventListener("error", () => {
    setConnected(false);
    // A refusal (signed out) closes it for good; a drop reconnects by itself after `retry`.
  });
}

/** Returns the way to stop listening. */
export function subscribeLiveTopic(topic: LiveTopic, handler: Handler): () => void {
  let set = handlers.get(topic);
  if (!set) {
    set = new Set();
    handlers.set(topic, set);
  }
  set.add(handler);
  reconcile();
  return () => {
    set.delete(handler);
    reconcile();
  };
}

export function subscribeLiveStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function liveConnected(): boolean {
  return connected;
}

/** Test seam. */
export function resetLiveClient(): void {
  source?.close();
  source = null;
  openedFor = "";
  connected = false;
  everOpened = false;
  handlers.clear();
  statusListeners.clear();
}
