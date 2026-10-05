/**
 * A cross-process claim on a named step, held as a row in `settings`: one INSERT, or one
 * compare-and-swap over a claim a crash left behind, wins on both dialects. Callers re-check their
 * invariant under it and always release it, so the next holder reads after their writes committed.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db from "./index";
import { settings } from "./schema";
import { domainError } from "../errors/domain-error";

/** Null when someone else holds `key` and their claim is younger than `ttlMs`. */
export async function claimRow(
  key: string,
  ttlMs: number,
  now = Date.now(),
): Promise<string | null> {
  const value = JSON.stringify({ token: randomBytes(16).toString("hex"), at: now });
  const updatedAt = new Date(now).toISOString();
  const inserted = await db
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoNothing()
    .returning({ key: settings.key });
  if (inserted.length > 0) return value;

  const [held] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  if (!held) return null;
  let at = 0;
  try {
    at = Number(JSON.parse(held.value).at) || 0;
  } catch {
    // Unreadable: treat as stale.
  }
  if (now - at <= ttlMs) return null;
  const taken = await db
    .update(settings)
    .set({ value, updatedAt })
    .where(and(eq(settings.key, key), eq(settings.value, held.value)))
    .returning({ key: settings.key });
  return taken.length > 0 ? value : null;
}

export async function releaseRow(key: string, claim: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.key, key), eq(settings.value, claim)));
}

/** Runs `work` holding `key`, waiting up to `waitMs` for a current holder to finish. */
export async function withRowLock<T>(
  key: string,
  work: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  const { ttlMs = 30_000, waitMs = 5_000 } = options;
  const deadline = Date.now() + waitMs;
  let claim = await claimRow(key, ttlMs);
  while (!claim) {
    if (Date.now() >= deadline) throw domainError("changeInProgress", {}, { status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
    claim = await claimRow(key, ttlMs);
  }
  try {
    return await work();
  } finally {
    await releaseRow(key, claim);
  }
}
