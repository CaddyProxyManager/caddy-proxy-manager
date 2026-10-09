/**
 * What a browser can ask to hear about. A topic carries no data: it says "re-read", so the page's
 * own endpoint does the permission checks and the filtering it always did.
 */

import type { requireCan } from "../users/permissions";

type Capability = Parameters<typeof requireCan>[0];

export const LIVE_TOPICS = ["analytics", "waf"] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** What the data endpoint behind each topic requires (`api-tokens/requirements.ts`). */
export const LIVE_TOPIC_CAPABILITY = {
  analytics: "analytics:read",
  waf: "security:read",
} as const satisfies Record<LiveTopic, Capability>;

export function isLiveTopic(value: string): value is LiveTopic {
  return (LIVE_TOPICS as readonly string[]).includes(value);
}

/** The cluster announcement a topic rides, so a replica that took the rows wakes the others' viewers. */
export function liveAnnouncement(topic: LiveTopic): string {
  return `live:${topic}`;
}
