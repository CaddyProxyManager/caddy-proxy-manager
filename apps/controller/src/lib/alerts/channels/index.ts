/**
 * Alert channels an administrator adds, by kind: what each stores, what may be shown back, and the
 * request a batch becomes. Anything that authorizes a post - a webhook URL with its token, a
 * signing key, a header value, an ntfy token - is `enc:v1` at rest and never leaves the server.
 */

import type { notificationChannels } from "../../db/schema";
import { domainError } from "../../errors/domain-error";
import { isLocalHost, isMetadataHost } from "../../http/outbound-url";
import { decryptSecret, encryptSecret } from "../../secrets";
import type { AlertBatch } from "../message";
import { discordPayload, discordUrl } from "./discord";
import { ntfyPayload, ntfyUrl } from "./ntfy";
import { slackPayload } from "./slack";
import { teamsPayload } from "./teams";
import {
  generateSigningSecret,
  messageId,
  RESERVED_HEADERS,
  signedHeaders,
  signingKey,
  webhookBody,
} from "./webhook";

export const CHANNEL_KINDS = ["webhook", "discord", "slack", "teams", "ntfy"] as const;
export type AddedChannelKind = (typeof CHANNEL_KINDS)[number];
export type ChannelKind = AddedChannelKind | "email" | "push";

/** Alerts per message: what each service shows well, the rest go in the next. */
export const BATCH_SIZE: Record<AddedChannelKind, number> = {
  webhook: 50,
  discord: 10,
  slack: 20,
  teams: 20,
  ntfy: 10,
};

export const MAX_HEADERS = 10;

/** Taken by the built-in channels: one added under either would block their creation. */
export const BUILTIN_CHANNEL_NAMES: ReadonlySet<string> = new Set(["email", "push"]);

export type ChannelHeader = { name: string; value: string };

export type ChannelInput = {
  name: string;
  kind: string;
  enabled?: boolean;
  /** Webhook, Discord, Slack and Teams. Blank keeps the stored one. */
  url?: string | null;
  /** Webhook: `whsec_` and base64. Blank keeps the stored one, or makes one for a new channel. */
  signingSecret?: string | null;
  /** Webhook: a blank value keeps that header's stored value. */
  headers?: ChannelHeader[] | null;
  /** ntfy. */
  server?: string | null;
  topic?: string | null;
  /** ntfy access token; blank keeps the stored one, `clearToken` removes it. */
  token?: string | null;
  clearToken?: boolean | null;
};

type Config = { server?: string; topic?: string; headerNames?: string[] };
type Secret = { url?: string; signingSecret?: string; headers?: ChannelHeader[]; token?: string };

export type Channel = {
  id: number;
  name: string;
  kind: ChannelKind;
  builtin: "email" | "push" | null;
  enabled: boolean;
  config: Config;
  secret: Secret;
  failures: number;
  retryAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelView = Omit<Channel, "secret" | "config"> & {
  /** Where it posts, with any path or query that may hold a token left out. */
  target: string;
  server: string | null;
  topic: string | null;
  headerNames: string[];
  hasSigningSecret: boolean;
  hasToken: boolean;
};

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseChannel(row: typeof notificationChannels.$inferSelect): Channel {
  const secret = row.secret ? parseJson(decryptSecret(row.secret, `channel "${row.name}"`)) : {};
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ChannelKind,
    builtin: row.builtin === "email" || row.builtin === "push" ? row.builtin : null,
    enabled: row.enabled,
    config: parseJson(row.config) as Config,
    secret: secret as Secret,
    failures: row.failures,
    retryAt: row.retryAt,
    lastSentAt: row.lastSentAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function redacted(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return "";
  }
}

export function channelView(channel: Channel): ChannelView {
  const { secret, config, ...rest } = channel;
  return {
    ...rest,
    target:
      channel.kind === "ntfy" ? `${config.server ?? ""}`.replace(/\/+$/, "") : redacted(secret.url),
    server: config.server ?? null,
    topic: config.topic ?? null,
    headerNames: (secret.headers ?? []).map((header) => header.name),
    hasSigningSecret: Boolean(secret.signingSecret),
    hasToken: Boolean(secret.token),
  };
}

/**
 * An address a channel may post to: http(s), no credentials or fragment, never a metadata
 * address, and plain http only to this network. Queries stay: Teams and Discord URLs carry them.
 */
export function channelUrl(raw: string, options: { https?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw domainError("alertChannelUrlInvalid", {}, { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw domainError("alertChannelUrlInvalid", {}, { status: 400 });
  }
  if (url.username || url.password || url.hash) {
    throw domainError("alertChannelUrlInvalid", {}, { status: 400 });
  }
  if (isMetadataHost(url.hostname)) {
    throw domainError("alertChannelUrlMetadata", {}, { status: 400 });
  }
  if (url.protocol === "http:" && (options.https || !isLocalHost(url.hostname))) {
    throw domainError("alertChannelUrlHttps", {}, { status: 400 });
  }
  return url.toString();
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

function headersFrom(input: ChannelHeader[], stored: ChannelHeader[]): ChannelHeader[] {
  if (input.length > MAX_HEADERS) {
    throw domainError("alertChannelHeaderInvalid", { max: MAX_HEADERS }, { status: 400 });
  }
  const seen = new Set<string>();
  return input.map(({ name, value }) => {
    const trimmed = name.trim();
    const lower = trimmed.toLowerCase();
    if (!HEADER_NAME.test(trimmed) || RESERVED_HEADERS.has(lower) || seen.has(lower)) {
      throw domainError("alertChannelHeaderInvalid", { max: MAX_HEADERS }, { status: 400 });
    }
    seen.add(lower);
    const kept = value
      ? value
      : stored.find((header) => header.name.toLowerCase() === lower)?.value;
    if (kept === undefined || /[\r\n]/.test(kept) || kept.length > 1024) {
      throw domainError("alertChannelHeaderInvalid", { max: MAX_HEADERS }, { status: 400 });
    }
    return { name: trimmed, value: kept };
  });
}

export type PreparedChannel = {
  name: string;
  kind: AddedChannelKind;
  enabled: boolean;
  config: string;
  secret: string;
  /** A signing secret this save made, to show once. */
  generatedSecret: string | null;
};

/** Validates an add or an edit; blank secret fields keep what `existing` stores. */
export function prepareChannel(input: ChannelInput, existing: Channel | null): PreparedChannel {
  const name = input.name?.trim() ?? "";
  if (!name || name.length > 100)
    throw domainError("alertChannelNameRequired", {}, { status: 400 });
  const kind = input.kind as AddedChannelKind;
  if (!CHANNEL_KINDS.includes(kind) || (existing && existing.kind !== kind)) {
    throw domainError("alertChannelKindInvalid", {}, { status: 400 });
  }
  const stored = existing?.secret ?? {};
  const config: Config = {};
  const secret: Secret = {};
  let generatedSecret: string | null = null;

  if (kind === "ntfy") {
    const server = (input.server ?? existing?.config.server ?? "").trim();
    if (!server) throw domainError("alertChannelUrlInvalid", {}, { status: 400 });
    config.server = channelUrl(server).replace(/\/+$/, "");
    const topic = (input.topic ?? existing?.config.topic ?? "").trim();
    if (!TOPIC.test(topic)) throw domainError("alertChannelTopicInvalid", {}, { status: 400 });
    config.topic = topic;
    const token = input.clearToken ? "" : input.token?.trim() || stored.token || "";
    if (/[\s]/.test(token) || token.length > 256) {
      throw domainError("alertChannelSecretInvalid", {}, { status: 400 });
    }
    if (token) secret.token = token;
  } else {
    const raw = input.url?.trim() || stored.url;
    if (!raw) throw domainError("alertChannelUrlInvalid", {}, { status: 400 });
    secret.url = channelUrl(raw, { https: kind !== "webhook" });
  }

  if (kind === "webhook") {
    let signing = input.signingSecret?.trim() || stored.signingSecret || "";
    if (!signing) {
      signing = generateSigningSecret();
      generatedSecret = signing;
    }
    if (!signingKey(signing)) throw domainError("alertChannelSecretInvalid", {}, { status: 400 });
    secret.signingSecret = signing;
    const headers = headersFrom(input.headers ?? stored.headers ?? [], stored.headers ?? []);
    if (headers.length > 0) secret.headers = headers;
  }

  return {
    name,
    kind,
    enabled: input.enabled ?? existing?.enabled ?? true,
    config: JSON.stringify(config),
    secret: Object.keys(secret).length > 0 ? encryptSecret(JSON.stringify(secret)) : "",
    generatedSecret,
  };
}

export type ChannelRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
  discord?: boolean;
};

/** What a batch becomes for this channel. */
export function channelRequest(
  channel: Channel,
  batch: AlertBatch,
  deliveryIds: readonly number[],
  now: number,
): ChannelRequest {
  const { secret, config } = channel;
  switch (channel.kind) {
    case "discord":
      return {
        url: discordUrl(secret.url ?? ""),
        body: JSON.stringify(discordPayload(batch)),
        headers: {},
        discord: true,
      };
    case "slack":
      return { url: secret.url ?? "", body: JSON.stringify(slackPayload(batch)), headers: {} };
    case "teams":
      return { url: secret.url ?? "", body: JSON.stringify(teamsPayload(batch)), headers: {} };
    case "ntfy":
      return {
        url: ntfyUrl(config.server ?? ""),
        body: JSON.stringify(ntfyPayload(batch, config.topic ?? "")),
        headers: secret.token ? { authorization: `Bearer ${secret.token}` } : {},
      };
    case "webhook": {
      const body = JSON.stringify(webhookBody(batch, now));
      const key = signingKey(secret.signingSecret ?? "");
      if (!key) throw domainError("alertChannelSecretInvalid", {}, { status: 400 });
      return {
        url: secret.url ?? "",
        body,
        headers: signedHeaders(key, messageId(deliveryIds), now, body, secret.headers ?? []),
      };
    }
    default:
      throw domainError("alertChannelKindInvalid", {}, { status: 400 });
  }
}
