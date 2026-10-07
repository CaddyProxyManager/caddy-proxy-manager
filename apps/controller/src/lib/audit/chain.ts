/**
 * Audit events as a keyed hash chain: each stores an HMAC of the previous hash and its canonical
 * content under a key derived from SESSION_SECRET, so editing, deleting or inserting an event
 * breaks a link Verify can point at, and write access to the database alone cannot rebuild one.
 * The head row is sealed under the same key, so it cannot be moved back over removed events, and
 * each event from before the chain carries a keyed mark, so one added without it is found at any id.
 *
 * Writers are serialized on the one `audit_chain` row, not on the events: every chained insert
 * reads the head and moves it inside the caller's transaction. PostgreSQL holds the head with
 * SELECT ... FOR UPDATE until commit, so `seq` order is commit order; SQLite has one writer and
 * runInTransaction's synchronous callback, so nothing interleaves. Events are ordered by `seq`,
 * never by id, which a sequence hands out before commit.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { config } from "../config";
import db, { nowIso, runInTransaction } from "../db";
import { auditChain, auditEvents, schemaDialect } from "../db/schema";
import { derivePurposeKey } from "../secrets/derived-key";
import { type Step, readingStep } from "../db/reading-step";
import { noteAuditFilterValues } from "./filter-options";

export const GENESIS_HASH = "0".repeat(64);
const HEAD_ID = 1;
const PAGE = 1000;
/** Replaces a seal that did not hold, so the next write cannot make it hold again. */
const BROKEN_SEAL = "broken";

const chainKey = (secret = config.sessionSecret) => derivePurposeKey("audit-chain:v1", secret);

function mac(key: Buffer, ...parts: string[]): string {
  const hmac = createHmac("sha256", key);
  for (const part of parts) hmac.update(part);
  return hmac.digest("hex");
}

function same(stored: string | null, expected: string): boolean {
  return (
    stored !== null &&
    stored.length === expected.length &&
    timingSafeEqual(Buffer.from(stored), Buffer.from(expected))
  );
}

/** What the chain covers: everything a reader sees except the user's display name. */
export type ChainedContent = {
  seq: number;
  actorId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  data: string | null;
  createdAt: string;
};

/** A fixed-order array, so a key added to the row later can't change an old event's hash. */
export function canonicalAuditContent(row: ChainedContent): string {
  return JSON.stringify([
    1,
    row.seq,
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    row.summary,
    row.data,
    row.createdAt,
  ]);
}

export function auditEventHash(prevHash: string, row: ChainedContent, key = chainKey()): string {
  return mac(key, prevHash, canonicalAuditContent(row));
}

/** An event from before the chain: bound to its id, since it has no place in the sequence. */
export function legacyAuditMark(
  row: Omit<ChainedContent, "seq"> & { id: number },
  key = chainKey(),
): string {
  return mac(
    key,
    JSON.stringify([
      "legacy",
      1,
      row.id,
      row.actorId,
      row.action,
      row.entityType,
      row.entityId,
      row.summary,
      row.data,
      row.createdAt,
    ]),
  );
}

export type AuditRow = {
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  data: string | null;
  createdAt: string;
};

type Head = typeof auditChain.$inferSelect;
type HeadState = Pick<Head, "headSeq" | "headHash" | "anchorSeq" | "anchorHash" | "legacyCount">;
type EventRow = typeof auditEvents.$inferSelect;

function headSeal(head: HeadState, key: Buffer): string {
  return mac(
    key,
    JSON.stringify([
      "head",
      1,
      head.headSeq,
      head.headHash,
      head.anchorSeq,
      head.anchorHash,
      head.legacyCount,
    ]),
  );
}

const GENESIS: HeadState = {
  headSeq: 0,
  headHash: GENESIS_HASH,
  anchorSeq: 0,
  anchorHash: GENESIS_HASH,
  legacyCount: 0,
};

const isGenesis = (head: HeadState) =>
  (Object.keys(GENESIS) as (keyof HeadState)[]).every((field) => head[field] === GENESIS[field]);

/** A fresh genesis row is valid unsealed; any other unsealed head predates the keyed chain. */
function sealState(head: Head, key: Buffer): "valid" | "unsealed" | "broken" {
  if (head.seal === null) return isGenesis(head) ? "valid" : "unsealed";
  return same(head.seal, headSeal(head, key)) ? "valid" : "broken";
}

function carrySeal(head: Head, next: HeadState, key: Buffer): string | null {
  const state = sealState(head, key);
  return state === "valid" ? headSeal(next, key) : state === "unsealed" ? null : BROKEN_SEAL;
}

/** Pure: the rows with their links, and where the head moves to. */
export function linkAuditRows(
  head: Pick<Head, "headSeq" | "headHash">,
  rows: AuditRow[],
  key = chainKey(),
) {
  let seq = head.headSeq;
  let prevHash = head.headHash;
  const values = rows.map((row) => {
    seq += 1;
    const content = { ...row, seq, actorId: row.userId };
    const hash = auditEventHash(prevHash, content, key);
    const linked = { ...row, actorId: row.userId, seq, prevHash, hash };
    prevHash = hash;
    return linked;
  });
  return { values, headSeq: seq, headHash: prevHash };
}

// ── Running reads inside runInTransaction ─────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: builder types are per-dialect
type Builder = any;

function* lockHead(tx: Builder): Generator<Step, Head, unknown[]> {
  const select = () => {
    const query = tx.select().from(auditChain).where(eq(auditChain.id, HEAD_ID));
    return schemaDialect === "postgres" ? query.for("update") : query;
  };
  let [head] = (yield { all: select() }) as Head[];
  if (!head) {
    // Only a database whose genesis row was removed by hand; the migration inserts it.
    yield {
      run: tx
        .insert(auditChain)
        .values({ id: HEAD_ID, ...GENESIS, seal: null, updatedAt: nowIso() })
        .onConflictDoNothing(),
    };
    [head] = (yield { all: select() }) as Head[];
  }
  return head as Head;
}

/** Use in place of `tx.insert(auditEvents)`: the rows join the chain in this transaction. */
export function chainedAuditInsert(tx: Builder, rows: AuditRow[]) {
  return readingStep(() => chainedAuditSteps(tx, rows));
}

/** As chainedAuditInsert, for a reading step that builds its rows from what it read. */
export function* chainedAuditSteps(
  tx: Builder,
  rows: AuditRow[],
): Generator<Step, void, unknown[]> {
  if (rows.length === 0) return;
  const key = chainKey();
  const head = yield* lockHead(tx);
  const linked = linkAuditRows(head, rows, key);
  yield { run: tx.insert(auditEvents).values(linked.values) };
  noteAuditFilterValues(rows);
  const next = { ...head, headSeq: linked.headSeq, headHash: linked.headHash };
  yield {
    run: tx
      .update(auditChain)
      .set({
        headSeq: next.headSeq,
        headHash: next.headHash,
        seal: carrySeal(head, next, key),
        updatedAt: nowIso(),
      })
      .where(eq(auditChain.id, HEAD_ID)),
  };
}

/**
 * Rewrites every link and mark under `key`, keeping the order and where the oldest event links
 * from, then seals the head. `append` joins the chain after them in the same transaction.
 */
function* rechain(
  tx: Builder,
  head: Head,
  key: Buffer,
  append: AuditRow[] = [],
): Generator<Step, void, unknown[]> {
  let legacyCount = 0;
  for (let after = 0; ; ) {
    const page = (yield {
      all: tx
        .select()
        .from(auditEvents)
        .where(and(isNull(auditEvents.seq), gt(auditEvents.id, after)))
        .orderBy(asc(auditEvents.id))
        .limit(PAGE),
    }) as EventRow[];
    for (const row of page) {
      const mark = legacyAuditMark(row, key);
      if (row.hash !== mark || row.prevHash !== null) {
        yield {
          run: tx
            .update(auditEvents)
            .set({ prevHash: null, hash: mark })
            .where(eq(auditEvents.id, row.id)),
        };
      }
      after = row.id;
    }
    legacyCount += page.length;
    if (page.length < PAGE) break;
  }

  const [oldest] = (yield {
    all: tx
      .select({ seq: auditEvents.seq, prevHash: auditEvents.prevHash })
      .from(auditEvents)
      .where(isNotNull(auditEvents.seq))
      .orderBy(asc(auditEvents.seq))
      .limit(1),
  }) as { seq: number; prevHash: string | null }[];
  // Nothing chained: the next event links to where the head already is.
  let next: HeadState = {
    headSeq: head.headSeq,
    headHash: head.headHash,
    anchorSeq: head.headSeq,
    anchorHash: head.headHash,
    legacyCount,
  };
  if (oldest) {
    let prev = oldest.prevHash ?? GENESIS_HASH;
    let last = oldest.seq - 1;
    next = { ...next, anchorSeq: last, anchorHash: prev };
    for (;;) {
      const page = (yield {
        all: tx
          .select()
          .from(auditEvents)
          .where(gt(auditEvents.seq, last))
          .orderBy(asc(auditEvents.seq))
          .limit(PAGE),
      }) as EventRow[];
      for (const row of page) {
        const seq = row.seq as number;
        const hash = auditEventHash(prev, { ...row, seq }, key);
        if (row.prevHash !== prev || row.hash !== hash) {
          yield {
            run: tx
              .update(auditEvents)
              .set({ prevHash: prev, hash })
              .where(eq(auditEvents.id, row.id)),
          };
        }
        prev = hash;
        last = seq;
      }
      if (page.length < PAGE) break;
    }
    next = { ...next, headSeq: last, headHash: prev };
  }

  if (append.length > 0) {
    const linked = linkAuditRows(next, append, key);
    yield { run: tx.insert(auditEvents).values(linked.values) };
    next = { ...next, headSeq: linked.headSeq, headHash: linked.headHash };
  }
  yield {
    run: tx
      .update(auditChain)
      .set({ ...next, seal: headSeal(next, key), updatedAt: nowIso() })
      .where(eq(auditChain.id, HEAD_ID)),
  };
}

/**
 * After a restore or an import replaced the events: those without a hash are adopted as predating
 * the chain, and every link is rewritten under this installation's key, since the file may come
 * from another's. Choosing the file was the operator's call; Verify covers it from here on.
 */
export async function reanchorAuditChain() {
  const key = chainKey();
  await runInTransaction((tx) => [
    readingStep(function* () {
      const head = yield* lockHead(tx);
      yield* rechain(tx, head, key);
    }),
  ]);
}

/** Retention: drops events older than `beforeIso` and anchors the chain at the newest one dropped. */
export async function pruneAuditEvents(beforeIso: string): Promise<number> {
  const key = chainKey();
  let deleted = 0;
  await runInTransaction((tx) => [
    readingStep(function* () {
      const head = yield* lockHead(tx);
      const [cut] = (yield {
        all: tx
          .select({ seq: auditEvents.seq, hash: auditEvents.hash })
          .from(auditEvents)
          .where(and(isNotNull(auditEvents.seq), lt(auditEvents.createdAt, beforeIso)))
          .orderBy(desc(auditEvents.seq))
          .limit(1),
      }) as { seq: number; hash: string | null }[];
      const legacy = (yield {
        all: tx
          .delete(auditEvents)
          .where(and(isNull(auditEvents.seq), lt(auditEvents.createdAt, beforeIso)))
          .returning(),
      }) as EventRow[];
      deleted = legacy.length;
      const marked = legacy.filter((row) => same(row.hash, legacyAuditMark(row, key))).length;
      let next: HeadState = { ...head, legacyCount: Math.max(0, head.legacyCount - marked) };
      if (cut) {
        const chained = (yield {
          // By seq, not time: a clock step back must not leave a hole in the middle of the chain.
          all: tx
            .delete(auditEvents)
            .where(lte(auditEvents.seq, cut.seq))
            .returning({ id: auditEvents.id }),
        }) as unknown[];
        deleted += chained.length;
        // Only the anchor moves: re-deriving the head would hide newest events removed by hand.
        if (cut.seq > head.anchorSeq) {
          next = { ...next, anchorSeq: cut.seq, anchorHash: cut.hash ?? GENESIS_HASH };
        }
      }
      yield {
        run: tx
          .update(auditChain)
          .set({
            anchorSeq: next.anchorSeq,
            anchorHash: next.anchorHash,
            legacyCount: next.legacyCount,
            seal: carrySeal(head, next, key),
            updatedAt: nowIso(),
          })
          .where(eq(auditChain.id, HEAD_ID)),
      };
    }),
  ]);
  return deleted;
}

// ── Startup: sealing and re-keying ──────────────────────────────────────────

/**
 * current: sealed under SESSION_SECRET; sealed: a chain from before the keyed scheme was re-hashed;
 * rekeyed: SESSION_SECRET_PREVIOUS's chain verified and moved to SESSION_SECRET; unverified: neither.
 */
export type AuditChainStartup = "current" | "sealed" | "rekeyed" | "unverified";

const rekeyEvent = (reason: "upgrade" | "rotation"): AuditRow => ({
  userId: null,
  action: "audit_rekeyed",
  entityType: "audit_log",
  entityId: null,
  summary: "Re-keyed the audit log's hash chain",
  data: JSON.stringify({ reason }),
  createdAt: nowIso(),
});

/**
 * Runs at startup before anything logs an event, which would break a seal the key does not match.
 * Rotation re-keys rather than Verify trying old keys too: a secret is often rotated because it
 * leaked, and a chain that still accepts it proves nothing. The old key's chain must verify first,
 * so a rotation cannot launder an edit, and the re-key is itself an event in the chain.
 */
export async function prepareAuditChain(
  secret = config.sessionSecret,
  previous = config.previousSessionSecrets,
): Promise<AuditChainStartup> {
  const key = chainKey(secret);
  const [head] = await db.select().from(auditChain).where(eq(auditChain.id, HEAD_ID));
  if (!head) return "current";

  // The unreleased unkeyed chain, or an upgrade's pre-chain events: nothing to verify them with.
  if (head.seal === null) {
    const [any] = await db.select({ id: auditEvents.id }).from(auditEvents).limit(1);
    if (!any && isGenesis(head)) return "current";
    await rewrite(key, head.seal, rekeyEvent("upgrade"));
    return "sealed";
  }
  if (sealState(head, key) === "valid") return "current";

  for (const old of previous) {
    if (old === secret) continue;
    const oldKey = chainKey(old);
    if (!same(head.seal, headSeal(head, oldKey))) continue;
    if (!(await verifyWith(oldKey)).ok) return "unverified";
    return (await rewrite(key, head.seal, rekeyEvent("rotation"))) ? "rekeyed" : "unverified";
  }
  return "unverified";
}

/** False when the head moved since `seal` was read, so what was verified is not what is there. */
async function rewrite(key: Buffer, seal: string | null, event: AuditRow): Promise<boolean> {
  let done = false;
  await runInTransaction((tx) => [
    readingStep(function* () {
      const head = yield* lockHead(tx);
      if (head.seal !== seal) return;
      yield* rechain(tx, head, key, [event]);
      done = true;
    }),
  ]);
  return done;
}

// ── Verify ──────────────────────────────────────────────────────────────────

export type AuditChainBreak = {
  /**
   * missing: an event in the sequence is gone; link: an event does not follow the one before it;
   * content: an event was changed after it was written; head: the chain ends somewhere other than
   * where the last write left it (newest events removed); unchained: an event was added outside the
   * chain; legacy: events from before the chain were removed.
   */
  reason: "missing" | "link" | "content" | "head" | "unchained" | "legacy";
  seq: number | null;
  eventId: number | null;
};

export type AuditChainVerification = {
  ok: boolean;
  /** Chained events checked. */
  checked: number;
  /** Events written before the chain existed, which carry a mark rather than a link. */
  legacy: number;
  firstBroken: AuditChainBreak | null;
  verifiedAt: string;
};

export async function verifyAuditChain(
  secret = config.sessionSecret,
): Promise<AuditChainVerification> {
  return await verifyWith(chainKey(secret));
}

async function verifyWith(key: Buffer): Promise<AuditChainVerification> {
  const verifiedAt = nowIso();
  const [stored] = await db.select().from(auditChain).where(eq(auditChain.id, HEAD_ID));
  const head: Head = stored ?? { id: HEAD_ID, ...GENESIS, seal: null, updatedAt: verifiedAt };

  let expected = head.anchorSeq + 1;
  let prev = head.anchorHash;
  let checked = 0;
  let broken: AuditChainBreak | null = null;
  outer: for (;;) {
    const page = await db
      .select()
      .from(auditEvents)
      .where(gt(auditEvents.seq, expected - 1))
      .orderBy(asc(auditEvents.seq))
      .limit(PAGE);
    for (const row of page) {
      const seq = row.seq as number;
      if (seq !== expected) {
        broken = { reason: "missing", seq: expected, eventId: null };
        break outer;
      }
      if (row.prevHash !== prev) {
        broken = { reason: "link", seq, eventId: row.id };
        break outer;
      }
      if (!same(row.hash, auditEventHash(prev, { ...row, seq }, key))) {
        broken = { reason: "content", seq, eventId: row.id };
        break outer;
      }
      prev = row.hash as string;
      expected += 1;
      checked += 1;
    }
    if (page.length < PAGE) break;
  }
  if (
    !broken &&
    (expected - 1 !== head.headSeq || prev !== head.headHash || sealState(head, key) !== "valid")
  ) {
    broken = { reason: "head", seq: expected, eventId: null };
  }

  // By mark, not by id: an event slipped in among the old ones has no mark either.
  let legacy = 0;
  let unmarked: number | null = null;
  for (let after = 0; ; ) {
    const page = await db
      .select()
      .from(auditEvents)
      .where(and(isNull(auditEvents.seq), gt(auditEvents.id, after)))
      .orderBy(asc(auditEvents.id))
      .limit(PAGE);
    for (const row of page) {
      if (same(row.hash, legacyAuditMark(row, key))) legacy += 1;
      else unmarked ??= row.id;
      after = row.id;
    }
    if (page.length < PAGE) break;
  }
  if (!broken && unmarked !== null) {
    broken = { reason: "unchained", seq: null, eventId: unmarked };
  }
  // Retention removed everything up to the anchor, so nothing may sit there now.
  const [belowAnchor] = await db
    .select({ id: auditEvents.id, seq: auditEvents.seq })
    .from(auditEvents)
    .where(lte(auditEvents.seq, head.anchorSeq))
    .orderBy(asc(auditEvents.seq))
    .limit(1);
  if (!broken && belowAnchor) {
    broken = { reason: "unchained", seq: belowAnchor.seq, eventId: belowAnchor.id };
  }
  if (!broken && legacy !== head.legacyCount) {
    broken = { reason: "legacy", seq: null, eventId: null };
  }
  return { ok: broken === null, checked, legacy, firstBroken: broken, verifiedAt };
}
