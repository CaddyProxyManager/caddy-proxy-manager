/**
 * Fan-out of "something changed" to this process's open streams. `publishLive` runs wherever the
 * rows landed and `announce` carries it to the other replicas; `subscribeLive` is the receiving end.
 */

import { announce, onAnnouncement } from "../cluster/announcements";
import { type LiveTopic, LIVE_TOPICS, liveAnnouncement } from "./topics";

/** A burst of batches is one wake-up: the viewer re-reads once, not per agent. */
export const LIVE_MIN_GAP_MS = 1000;

type Listener = () => void;

type Bus = {
  listeners: Map<LiveTopic, Set<Listener>>;
  lastSent: Map<LiveTopic, number>;
  pending: Map<LiveTopic, ReturnType<typeof setTimeout>>;
};

// On globalThis because the dev server reloads modules, and a second copy would register a second
// announcement handler beside the first.
const KEY = Symbol.for("cpm.live.bus");
const store = globalThis as unknown as { [KEY]?: Bus };

function bus(): Bus {
  let current = store[KEY];
  if (!current) {
    current = { listeners: new Map(), lastSent: new Map(), pending: new Map() };
    store[KEY] = current;
    const created = current;
    for (const topic of LIVE_TOPICS) {
      onAnnouncement(liveAnnouncement(topic), () => {
        for (const listener of created.listeners.get(topic) ?? []) listener();
      });
    }
  }
  return current;
}

/** Returns the way to stop listening. */
export function subscribeLive(topic: LiveTopic, listener: Listener): () => void {
  const { listeners } = bus();
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * Leading and trailing: the first call goes out at once, and the ones inside the next gap collapse
 * into a single announcement when it ends, so the last batch is never left unannounced.
 */
export function publishLive(topic: LiveTopic, now: number = Date.now()): void {
  const state = bus();
  if (state.pending.has(topic)) return;
  const wait = (state.lastSent.get(topic) ?? 0) + LIVE_MIN_GAP_MS - now;
  if (wait <= 0) {
    state.lastSent.set(topic, now);
    announce(liveAnnouncement(topic));
    return;
  }
  const timer = setTimeout(() => {
    state.pending.delete(topic);
    state.lastSent.set(topic, Date.now());
    announce(liveAnnouncement(topic));
  }, wait);
  timer.unref?.();
  state.pending.set(topic, timer);
}

/** Test seam. */
export function resetLiveBus(): void {
  const state = store[KEY];
  if (!state) return;
  for (const timer of state.pending.values()) clearTimeout(timer);
  state.pending.clear();
  state.lastSent.clear();
  state.listeners.clear();
}
