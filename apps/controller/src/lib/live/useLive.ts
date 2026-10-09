"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { liveConnected, subscribeLiveStatus, subscribeLiveTopic } from "./client";
import type { LiveTopic } from "./topics";

/**
 * Calls `onInvalidate` whenever the server says `topic` changed, and returns whether the stream is
 * up - a caller keeps a slow timer for when it is not. `onInvalidate` may change every render.
 * `minGapMs` spaces the calls for a reader that is dear (a server render): the first goes at once
 * and the rest inside the gap collapse into one when it ends.
 */
export function useLive(
  topic: LiveTopic,
  onInvalidate: () => void,
  enabled = true,
  minGapMs = 0,
): boolean {
  const latest = useRef(onInvalidate);
  latest.current = onInvalidate;

  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      last = Date.now();
      latest.current();
    };
    const stop = subscribeLiveTopic(topic, () => {
      const wait = last + minGapMs - Date.now();
      if (wait <= 0) return fire();
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, wait);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [topic, enabled, minGapMs]);

  return useSyncExternalStore(subscribeLiveStatus, liveConnected, () => false);
}
