/**
 * A Slack incoming-webhook message. `text` is always there: it is the notification and the
 * fallback wherever blocks are not shown. At most 50 blocks; Slack takes about one message a
 * second per webhook, which a batch a minute stays far below.
 */

import { type AlertBatch, clip } from "../message";

export const SLACK_LIMITS = { blocks: 50, sectionText: 3000, header: 150, text: 4000 } as const;

type Block =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | {
      type: "actions";
      elements: { type: "button"; text: { type: "plain_text"; text: string }; url: string }[];
    };

export type SlackPayload = { text: string; blocks: Block[] };

/** Slack reads `&`, `<` and `>` as markup. */
function mrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function slackPayload(batch: AlertBatch): SlackPayload {
  const header: Block = {
    type: "header",
    text: { type: "plain_text", text: clip(batch.subject, SLACK_LIMITS.header) },
  };
  const action: Block = {
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: batch.labels.open }, url: batch.url },
    ],
  };
  // Header, the action, and a closing note if anything is left out; two blocks per alert.
  const room = Math.floor((SLACK_LIMITS.blocks - 3) / 2);
  const shown = batch.items.slice(0, room);
  const blocks: Block[] = [header];
  for (const item of shown) {
    const tone = item.resolved ? "resolved" : item.severity;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(`*${mrkdwn(item.title)}*\n${mrkdwn(item.text)}`, SLACK_LIMITS.sectionText),
      },
    });
    if (item.facts === false) continue;
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: mrkdwn(
            [batch.labels.severities[tone], item.time, ...(item.rule ? [item.rule] : [])].join(
              " · ",
            ),
          ),
        },
      ],
    });
  }
  const left = batch.items.length - shown.length;
  if (left > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: batch.labels.more(left) }] });
  }
  blocks.push(action);
  const text = clip(
    [batch.subject, ...batch.items.map((item) => `- ${item.text}`)].join("\n"),
    SLACK_LIMITS.text,
  );
  return { text, blocks };
}
