/**
 * A Discord webhook message: one embed per alert, coloured by severity, inside Discord's limits
 * (10 embeds, 25 fields each, 2000 characters of content, 6000 across every embed). Posted with
 * `?wait=true`, so Discord answers with the message it made and a drop is an error, not silence.
 */

import type { AlertSeverity } from "../../notifications/builtins";
import { type AlertBatch, type AlertItem, clip } from "../message";

export const DISCORD_LIMITS = {
  embeds: 10,
  fields: 25,
  content: 2000,
  total: 6000,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
} as const;

/** Integers, as Discord takes them. */
export const DISCORD_COLOURS: Record<AlertSeverity | "resolved", number> = {
  critical: 0xd92d20,
  warning: 0xf79009,
  info: 0x2e90fa,
  resolved: 0x12b76a,
};

export type DiscordEmbed = {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  url?: string;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string };
};

export type DiscordPayload = { content: string; embeds: DiscordEmbed[] };

function embedSize(embed: DiscordEmbed): number {
  return (
    embed.title.length +
    embed.description.length +
    embed.footer.text.length +
    embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

function embedFor(item: AlertItem, batch: AlertBatch): DiscordEmbed {
  const tone = item.resolved ? "resolved" : item.severity;
  const fields = (
    item.facts === false
      ? []
      : [
          { name: batch.labels.severity, value: batch.labels.severities[tone], inline: true },
          { name: batch.labels.time, value: item.time, inline: true },
          ...(item.rule ? [{ name: batch.labels.rule, value: item.rule, inline: true }] : []),
        ]
  ).slice(0, DISCORD_LIMITS.fields);
  return {
    title: clip(item.title, DISCORD_LIMITS.title),
    description: clip(item.text, DISCORD_LIMITS.description),
    color: DISCORD_COLOURS[tone],
    timestamp: item.at,
    url: batch.url,
    fields: fields.map((field) => ({
      name: clip(field.name, DISCORD_LIMITS.fieldName),
      value: clip(field.value, DISCORD_LIMITS.fieldValue),
      inline: field.inline,
    })),
    footer: { text: clip(batch.appName, DISCORD_LIMITS.footer) },
  };
}

export function discordPayload(batch: AlertBatch): DiscordPayload {
  const embeds = batch.items.slice(0, DISCORD_LIMITS.embeds).map((item) => embedFor(item, batch));
  // The whole message counts against 6000: drop from the end, then shorten what one embed says.
  while (
    embeds.length > 1 &&
    embeds.reduce((sum, e) => sum + embedSize(e), 0) > DISCORD_LIMITS.total
  )
    embeds.pop();
  if (embeds.length === 1 && embedSize(embeds[0]) > DISCORD_LIMITS.total) {
    const over = embedSize(embeds[0]) - DISCORD_LIMITS.total;
    embeds[0].description = clip(
      embeds[0].description,
      Math.max(1, embeds[0].description.length - over),
    );
  }
  const left = batch.items.length - embeds.length;
  const content = left > 0 ? `${batch.subject}\n${batch.labels.more(left)}` : batch.subject;
  return { content: clip(content, DISCORD_LIMITS.content), embeds };
}

/** Discord's webhook URL with `wait=true`, keeping a `thread_id` the operator put there. */
export function discordUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("wait", "true");
  return parsed.toString();
}

/** Discord's own wait, from the body: the header rounds it up to whole seconds. */
export function discordRetryAfterMs(body: string): number | null {
  try {
    const value = (JSON.parse(body) as { retry_after?: unknown }).retry_after;
    return typeof value === "number" && value >= 0 ? Math.ceil(value * 1000) : null;
  } catch {
    return null;
  }
}
