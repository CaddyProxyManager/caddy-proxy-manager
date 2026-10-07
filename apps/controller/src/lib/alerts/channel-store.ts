/**
 * Alert channels as the Alerts page and GraphQL change them, each change audited once here. The
 * built-in email and push are listed but not edited here: Settings and Profile own them.
 */

import { asc, eq, isNull } from "drizzle-orm";
import { logAuditEvent } from "../audit";
import db, { nowIso, runInTransaction } from "../db";
import { alertDigests, alertRules, notificationChannels } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { builtins } from "../notifications/builtins";
import { jsonArray } from "../notifications/rules";
import {
  BUILTIN_CHANNEL_NAMES,
  type Channel,
  type ChannelInput,
  type ChannelView,
  channelRequest,
  channelView,
  parseChannel,
  prepareChannel,
} from "./channels";
import { postJson } from "./channels/send";
import { alertBatch } from "./message";

export async function listChannels(): Promise<ChannelView[]> {
  await builtins();
  const rows = await db.select().from(notificationChannels).orderBy(asc(notificationChannels.id));
  return rows.map((row) => channelView(parseChannel(row)));
}

export async function getChannel(id: number): Promise<Channel | null> {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  return row ? parseChannel(row) : null;
}

async function requireAddedChannel(id: number): Promise<Channel> {
  const channel = await getChannel(id);
  if (!channel) throw domainError("alertChannelNotFound", {}, { status: 404 });
  if (channel.builtin) throw domainError("alertChannelBuiltin", {}, { status: 400 });
  return channel;
}

async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  if (BUILTIN_CHANNEL_NAMES.has(name.toLowerCase())) {
    throw domainError("alertChannelNameTaken", { name }, { status: 409 });
  }
  const [clash] = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(eq(notificationChannels.name, name));
  if (clash && clash.id !== exceptId) {
    throw domainError("alertChannelNameTaken", { name }, { status: 409 });
  }
}

export type SavedChannel = ChannelView & { signingSecret: string | null };

export async function createChannel(
  input: ChannelInput,
  userId: number | null,
): Promise<SavedChannel> {
  // The built-in two first, so they keep the lowest ids and their names.
  await builtins();
  const prepared = prepareChannel(input, null);
  await assertNameFree(prepared.name, null);
  const at = nowIso();
  const [row] = await db
    .insert(notificationChannels)
    .values({
      name: prepared.name,
      kind: prepared.kind,
      enabled: prepared.enabled,
      config: prepared.config,
      secret: prepared.secret,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  await logAuditEvent({
    userId,
    action: "create",
    entityType: "alert_channel",
    entityId: row.id,
    summary: `Created alert channel ${row.name}`,
  });
  return { ...channelView(parseChannel(row)), signingSecret: prepared.generatedSecret };
}

export async function updateChannel(
  id: number,
  input: ChannelInput,
  userId: number | null,
): Promise<SavedChannel> {
  const existing = await requireAddedChannel(id);
  const prepared = prepareChannel(input, existing);
  await assertNameFree(prepared.name, id);
  const [row] = await db
    .update(notificationChannels)
    .set({
      name: prepared.name,
      enabled: prepared.enabled,
      config: prepared.config,
      secret: prepared.secret,
      // A fixed channel deserves a try now rather than after the backoff it earned while broken.
      retryAt: null,
      updatedAt: nowIso(),
    })
    .where(eq(notificationChannels.id, id))
    .returning();
  await logAuditEvent({
    userId,
    action: "update",
    entityType: "alert_channel",
    entityId: id,
    summary: `Updated alert channel ${row.name}`,
  });
  return { ...channelView(parseChannel(row)), signingSecret: prepared.generatedSecret };
}

/** Taken out of every rule and digest in the same transaction; its deliveries go with it. */
export async function deleteChannel(id: number, userId: number | null): Promise<void> {
  const channel = await requireAddedChannel(id);
  const [rules, digests] = await Promise.all([
    db.select({ id: alertRules.id, channelIds: alertRules.channelIds }).from(alertRules),
    db.select({ id: alertDigests.id, channelIds: alertDigests.channelIds }).from(alertDigests),
  ]);
  const without = (text: string) => JSON.stringify(jsonArray(text).filter((value) => value !== id));
  const at = nowIso();
  await runInTransaction((tx) => [
    ...rules
      .filter((rule) => jsonArray(rule.channelIds).includes(id))
      .map((rule) =>
        tx
          .update(alertRules)
          .set({ channelIds: without(rule.channelIds), updatedAt: at })
          .where(eq(alertRules.id, rule.id)),
      ),
    ...digests
      .filter((digest) => jsonArray(digest.channelIds).includes(id))
      .map((digest) =>
        tx
          .update(alertDigests)
          .set({ channelIds: without(digest.channelIds), updatedAt: at })
          .where(eq(alertDigests.id, digest.id)),
      ),
    tx.delete(notificationChannels).where(eq(notificationChannels.id, id)),
  ]);
  await logAuditEvent({
    userId,
    action: "delete",
    entityType: "alert_channel",
    entityId: id,
    summary: `Deleted alert channel ${channel.name}`,
  });
}

/** Whether the service said it delivered the test, or only that it accepted it (Teams). */
export type ChannelTestResult = { outcome: "delivered" | "accepted"; recipients?: string[] };

/**
 * Straight to the channel, nothing queued; throws with the receiver's answer so the page can say
 * why. An unsaved form is tested as typed, its blank secrets filled from the stored channel.
 */
export async function testChannel(
  id: number | null,
  input: ChannelInput | null,
  now = Date.now(),
): Promise<ChannelTestResult> {
  const stored = id === null ? null : await getChannel(id);
  if (id !== null && !stored) throw domainError("alertChannelNotFound", {}, { status: 404 });
  if (stored?.builtin === "email") {
    const { sendTestNotification } = await import("../notifications");
    return { outcome: "delivered", recipients: await sendTestNotification(now) };
  }
  if (stored?.builtin === "push") {
    const { sendTestPush } = await import("../notifications/push");
    const { delivered } = await sendTestPush(now);
    if (delivered === 0) throw domainError("alertChannelPushNone", {}, { status: 400 });
    return { outcome: "accepted" };
  }
  let channel: Channel;
  if (input) {
    const prepared = prepareChannel(input, stored);
    channel = parseChannel({
      id: stored?.id ?? 0,
      name: prepared.name,
      kind: prepared.kind,
      builtin: null,
      config: prepared.config,
      secret: prepared.secret,
      enabled: true,
      failures: 0,
      retryAt: null,
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
      lastErrorCode: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  } else if (stored) {
    channel = stored;
  } else {
    throw domainError("alertChannelNotFound", {}, { status: 404 });
  }
  const batch = await alertBatch([
    {
      id: 0,
      at: new Date(now).toISOString(),
      event: { kind: "channelTest", channel: channel.name },
      severity: "info",
      rule: null,
    },
  ]);
  const request = channelRequest(channel, batch, [now], now);
  const result = await postJson(request.url, request.body, request.headers, {
    discord: request.discord,
  });
  if (!result.ok) {
    throw domainError("alertChannelTestFailed", { error: result.error }, { status: 400 });
  }
  return { outcome: channel.kind === "teams" || result.status === 202 ? "accepted" : "delivered" };
}

export async function addedChannelIds(): Promise<number[]> {
  const rows = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(isNull(notificationChannels.builtin));
  return rows.map((row) => row.id);
}
