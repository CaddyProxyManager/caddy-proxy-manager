/**
 * An ntfy message, published as JSON to the server root with the topic in the body: the form that
 * takes a title, priority and tags without header encoding. Priority 1-5, tags as an array.
 */

import { type AlertBatch, clip } from "../message";

/** ntfy keeps a message up to 4096 bytes as text; longer becomes an attachment. */
const MESSAGE_MAX = 3500;

export type NtfyPayload = {
  topic: string;
  title: string;
  message: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  click: string;
};

const PRIORITY = { critical: 5, warning: 4, info: 3, resolved: 2 } as const;
/** ntfy shows these short codes as emoji in front of the title. */
const TAG = {
  critical: "rotating_light",
  warning: "warning",
  info: "information_source",
  resolved: "white_check_mark",
} as const;

export function ntfyPayload(batch: AlertBatch, topic: string): NtfyPayload {
  const tones = batch.items.map((item) => (item.resolved ? "resolved" : item.severity));
  const worst = (["critical", "warning", "info", "resolved"] as const).find((tone) =>
    tones.includes(tone),
  );
  const tone = worst ?? "info";
  return {
    topic,
    title: clip(batch.subject, 250),
    message: clip(batch.items.map((item) => item.text).join("\n\n"), MESSAGE_MAX),
    priority: PRIORITY[tone],
    tags: [TAG[tone]],
    click: batch.url,
  };
}

/** The server root the JSON is published to. */
export function ntfyUrl(server: string): string {
  const url = new URL(server);
  url.pathname = "/";
  url.search = "";
  return url.toString();
}
