/**
 * Sends daily digests on the leader: one `Bun.cron` per enabled digest, in its own time zone,
 * re-created whenever a digest changes. A send claims its slot first, so a leadership flip never
 * sends one twice; a leader taking over sends each digest's latest owed slot once. Email goes to
 * each recipient in their own locale and time zone; chat channels get the compact form.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { onAnnouncement, replicaId } from "../cluster";
import { type CronJob, cronHandler, latestSlot, missedSlot, scheduleJobs } from "../cron";
import db from "../db";
import { alertDigestRuns, notificationChannels, pushSubscriptions, users } from "../db/schema";
import { sendEmail } from "../email/transport";
import { DEFAULT_LOCALE, type Locale, parseLocale } from "../locale";
import { channelRequest, parseChannel } from "./channels";
import { postJson } from "./channels/send";
import { collectDigest, type DigestData } from "./digest-content";
import { digestBatch, digestEmail, type RenderedDigest, renderDigest } from "./digest-render";
import {
  DIGESTS_CHANGED,
  type Digest,
  type DigestRun,
  getDigest,
  listEnabledDigests,
  parseRun,
  requireDigest,
} from "./digests";
import { alertBatch } from "./message";

export type DigestTrigger = "schedule" | "catch-up" | "manual";

const iso = (ms: number) => new Date(ms).toISOString();

let collect: (now: number) => Promise<DigestData> = collectDigest;

/** Test seam: what a digest reports, instead of the live sources. */
export function setDigestCollectorForTests(fake: ((now: number) => Promise<DigestData>) | null) {
  collect = fake ?? collectDigest;
}

/** Null when another process holds the slot. */
async function claimRun(digestId: number, slot: number, trigger: DigestTrigger) {
  const [row] = await db
    .insert(alertDigestRuns)
    .values({
      digestId,
      slot,
      trigger,
      status: "running",
      replica: replicaId(),
      startedAt: iso(Date.now()),
    })
    .onConflictDoNothing()
    .returning({ id: alertDigestRuns.id });
  return row?.id ?? null;
}

type Reader = { address: string; locale: Locale; timeZone: string };

/**
 * Whoever the built-in email reaches, each with their stored time zone and the locale their
 * browser last subscribed to push with; a listed address that is no account reads it in the
 * digest's own zone.
 */
async function emailReaders(digest: Digest): Promise<Reader[]> {
  const { notificationAudiences } = await import("../notifications/audience");
  const audiences = (await notificationAudiences({ email: true })).flatMap((audience) =>
    audience.kind === "email" ? [audience.address] : [],
  );
  if (audiences.length === 0) return [];
  const accounts = await db
    .select({ id: users.id, email: users.email, timeZone: users.timeZone })
    .from(users);
  const locales = await db
    .select({ userId: pushSubscriptions.userId, locale: pushSubscriptions.locale })
    .from(pushSubscriptions)
    .orderBy(desc(pushSubscriptions.createdAt));
  return audiences.map((address) => {
    const account = accounts.find((row) => row.email.toLowerCase() === address.toLowerCase());
    const locale = account
      ? parseLocale(locales.find((row) => row.userId === account.id)?.locale ?? undefined)
      : undefined;
    return {
      address,
      locale: locale ?? DEFAULT_LOCALE,
      timeZone: account?.timeZone || digest.timeZone,
    };
  });
}

export type ChannelResult = { channelId: number; name: string; ok: boolean; error?: string };

/** Every channel the digest names, each on its own: one failing never stops the rest. */
export async function sendDigest(
  digest: Digest,
  data: DigestData,
  now: number,
): Promise<ChannelResult[]> {
  const rows =
    digest.channelIds.length === 0
      ? []
      : await db
          .select()
          .from(notificationChannels)
          .where(inArray(notificationChannels.id, digest.channelIds));
  const results: ChannelResult[] = [];
  let chat: RenderedDigest | null = null;
  for (const row of rows) {
    try {
      if (row.builtin === "email") {
        const readers = await emailReaders(digest);
        const groups = new Map<string, Reader[]>();
        for (const reader of readers) {
          const key = `${reader.locale}|${reader.timeZone}`;
          groups.set(key, [...(groups.get(key) ?? []), reader]);
        }
        for (const group of groups.values()) {
          const rendered = await renderDigest(data, group[0]);
          await sendEmail(
            digestEmail(
              rendered,
              group.map((reader) => reader.address),
            ),
          );
        }
        results.push({
          channelId: row.id,
          name: row.name,
          ok: readers.length > 0,
          ...(readers.length === 0 && { error: "noRecipients" }),
        });
        continue;
      }
      if (row.builtin || !row.enabled) continue;
      chat ??= await renderDigest(data, { timeZone: digest.timeZone });
      const base = await alertBatch([]);
      const channel = parseChannel(row);
      const request = channelRequest(channel, digestBatch(chat, base, now), [digest.id, now], now);
      const result = await postJson(request.url, request.body, request.headers, {
        discord: request.discord,
      });
      results.push(
        result.ok
          ? { channelId: row.id, name: row.name, ok: true }
          : { channelId: row.id, name: row.name, ok: false, error: result.error.slice(0, 300) },
      );
    } catch (error) {
      results.push({
        channelId: row.id,
        name: row.name,
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }
  return results;
}

/**
 * Collects, renders and sends one digest for a claimed slot. Null when another process holds the
 * slot. Throws nothing a send causes: the outcome is on the run row.
 */
export async function runDigest(
  digestId: number,
  slot: number,
  trigger: DigestTrigger,
  now: () => number = Date.now,
): Promise<number | null> {
  const runId = await claimRun(digestId, slot, trigger);
  if (runId === null) return null;
  let status = "failed";
  let results: ChannelResult[] = [];
  let error: string | null = null;
  try {
    const digest = await requireDigest(digestId);
    results = await sendDigest(digest, await collect(now()), now());
    const sent = results.filter((result) => result.ok).length;
    status = sent === results.length && sent > 0 ? "sent" : sent > 0 ? "partial" : "failed";
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 500);
  }
  await db
    .update(alertDigestRuns)
    .set({ status, results: JSON.stringify(results), error, finishedAt: iso(now()) })
    .where(eq(alertDigestRuns.id, runId))
    .catch((recordError: unknown) => {
      console.error("[alerts] could not record a digest run:", recordError);
    });
  return runId;
}

export async function getDigestRun(id: number): Promise<DigestRun | null> {
  const [row] = await db.select().from(alertDigestRuns).where(eq(alertDigestRuns.id, id));
  return row ? parseRun(row) : null;
}

/** "Send now": the run once finished. */
export async function sendDigestNow(digestId: number): Promise<DigestRun | null> {
  await requireDigest(digestId);
  const runId = await runDigest(digestId, Date.now(), "manual");
  return runId === null ? null : getDigestRun(runId);
}

/** What the digest would say right now, to this reader. */
export async function previewDigest(
  digestId: number,
  reader: { locale?: Locale; timeZone?: string | null },
  now = Date.now(),
): Promise<{ subject: string; text: string }> {
  const digest = await requireDigest(digestId);
  const rendered = await renderDigest(await collect(now), {
    locale: reader.locale,
    timeZone: reader.timeZone || digest.timeZone,
  });
  const email = digestEmail(rendered, []);
  return { subject: email.subject, text: email.text };
}

/** A fire may land a little after its slot; a little before would credit the previous one. */
const FIRE_TOLERANCE_MS = 2_000;

function fire(digest: Digest): () => Promise<void> {
  return cronHandler(async () => {
    const slot = latestSlot(digest.cron, digest.timeZone, Date.now() + FIRE_TOLERANCE_MS);
    if (slot !== null) await runDigest(digest.id, slot, "schedule");
  });
}

/** On taking over: each digest's latest owed slot, at most one each. */
export async function catchUpDigests(
  digests: readonly Digest[],
  now = Date.now(),
): Promise<number[]> {
  const sent: number[] = [];
  for (const digest of digests) {
    const [last] = await db
      .select({ slot: alertDigestRuns.slot })
      .from(alertDigestRuns)
      .where(eq(alertDigestRuns.digestId, digest.id))
      .orderBy(desc(alertDigestRuns.slot))
      .limit(1);
    const since = Math.max(Date.parse(digest.scheduledSince) || 0, last?.slot ?? 0);
    const slot = missedSlot(digest, since, now);
    if (slot === null) continue;
    await cronHandler(async () => {
      if ((await runDigest(digest.id, slot, "catch-up")) !== null) sent.push(digest.id);
    })();
  }
  return sent;
}

const state = { active: false, generation: 0, jobs: new Map<number, CronJob>() };

function stopJobs(): void {
  for (const job of state.jobs.values()) {
    try {
      job.stop();
    } catch {
      // Already stopped.
    }
  }
  state.jobs = new Map();
}

async function reload(catchUp: boolean): Promise<void> {
  const generation = ++state.generation;
  stopJobs();
  const digests = await listEnabledDigests();
  if (!state.active || generation !== state.generation) return;
  state.jobs = scheduleJobs(digests, fire, undefined, "alerts").jobs;
  if (catchUp) {
    // A run a dead leader left running is over; a young one may still be finishing elsewhere.
    await db
      .update(alertDigestRuns)
      .set({ status: "failed", error: "interrupted", finishedAt: iso(Date.now()) })
      .where(
        and(
          eq(alertDigestRuns.status, "running"),
          lt(alertDigestRuns.startedAt, iso(Date.now() - 10 * 60_000)),
        ),
      );
    await catchUpDigests(digests);
  }
}

function reloadQuietly(catchUp: boolean): void {
  void reload(catchUp).catch((error: unknown) => {
    console.error("[alerts] could not load the digests:", error);
  });
}

export function startDigestScheduler(): void {
  state.active = true;
  reloadQuietly(true);
}

export function stopDigestScheduler(): void {
  state.active = false;
  state.generation++;
  stopJobs();
}

onAnnouncement(DIGESTS_CHANGED, () => {
  if (state.active) reloadQuietly(false);
});

export { getDigest };
