/**
 * A Teams Workflows webhook post: one Adaptive Card (version 1.2) as an attachment, kept under
 * the 28 KB a card may weigh. The workflow may accept the request before the card is posted, so a
 * 2xx means accepted, not delivered. At most about four requests a second per webhook.
 */

import { type AlertBatch, type AlertItem, clip } from "../message";

export const TEAMS_MAX_BYTES = 28 * 1024;
const TEXT_MAX = 2000;

type CardElement =
  | {
      type: "TextBlock";
      text: string;
      wrap: true;
      weight?: "Bolder";
      size?: "Medium";
      color?: "Attention" | "Warning" | "Good" | "Accent";
      spacing?: "None";
      isSubtle?: boolean;
    }
  | { type: "FactSet"; facts: { title: string; value: string }[] };

export type TeamsPayload = {
  type: "message";
  attachments: {
    contentType: "application/vnd.microsoft.card.adaptive";
    contentUrl: null;
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json";
      type: "AdaptiveCard";
      version: "1.2";
      body: CardElement[];
      actions: { type: "Action.OpenUrl"; title: string; url: string }[];
    };
  }[];
};

const COLOURS = {
  critical: "Attention",
  warning: "Warning",
  info: "Accent",
  resolved: "Good",
} as const;

function itemElements(item: AlertItem, batch: AlertBatch): CardElement[] {
  const tone = item.resolved ? "resolved" : item.severity;
  return [
    {
      type: "TextBlock",
      text: clip(item.title, TEXT_MAX),
      wrap: true,
      weight: "Bolder",
      color: COLOURS[tone],
    },
    { type: "TextBlock", text: clip(item.text, TEXT_MAX), wrap: true, spacing: "None" },
    ...(item.facts === false ? [] : [factSet(item, batch, tone)]),
  ];
}

function factSet(item: AlertItem, batch: AlertBatch, tone: keyof typeof COLOURS): CardElement {
  return {
    type: "FactSet",
    facts: [
      { title: batch.labels.severity, value: batch.labels.severities[tone] },
      { title: batch.labels.time, value: item.time },
      ...(item.rule ? [{ title: batch.labels.rule, value: item.rule }] : []),
    ],
  };
}

function card(batch: AlertBatch, shown: number): TeamsPayload {
  const body: CardElement[] = [
    {
      type: "TextBlock",
      text: clip(batch.subject, TEXT_MAX),
      wrap: true,
      weight: "Bolder",
      size: "Medium",
    },
    ...batch.items.slice(0, shown).flatMap((item) => itemElements(item, batch)),
  ];
  const left = batch.items.length - shown;
  if (left > 0)
    body.push({ type: "TextBlock", text: batch.labels.more(left), wrap: true, isSubtle: true });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
          actions: [{ type: "Action.OpenUrl", title: batch.labels.open, url: batch.url }],
        },
      },
    ],
  };
}

export function teamsSize(payload: TeamsPayload): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/** As many alerts as fit under the limit, the rest counted at the end. */
export function teamsPayload(batch: AlertBatch): TeamsPayload {
  let shown = batch.items.length;
  let payload = card(batch, shown);
  while (shown > 0 && teamsSize(payload) >= TEAMS_MAX_BYTES) {
    shown -= 1;
    payload = card(batch, shown);
  }
  return payload;
}
