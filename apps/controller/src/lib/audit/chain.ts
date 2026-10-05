/**
 * Audit events as a SHA-256 hash chain: each stores sha256(previous hash + its canonical content),
 * so editing, deleting or inserting an event breaks a link Verify can point at.
 *
 * Writers are serialized on the one `audit_chain` row, not on the events: every chained insert
 * reads the head and moves it inside the caller's transaction. PostgreSQL holds the head with
 * SELECT ... FOR UPDATE until commit, so `seq` order is commit order; SQLite has one writer and
 * runInTransaction's synchronous callback, so nothing interleaves. Events are ordered by `seq`,
 * never by id, which a sequence hands out before commit.
 */
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNotNull, isNull, lt, max, min } from "drizzle-orm";
import db, { nowIso, runInTransaction } from "../db";
import { auditChain, auditEvents, schemaDialect } from "../db/schema";

export const GENESIS_HASH = "0".repeat(64);
const HEAD_ID = 1;
const VERIFY_PAGE = 1000;

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

export function auditEventHash(prevHash: string, row: ChainedContent): string {
  return createHash("sha256").update(prevHash).update(canonicalAuditContent(row)).digest("hex");
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

/** Pure: the rows with their links, and where the head moves to. */
export function linkAuditRows(head: Pick<Head, "headSeq" | "headHash">, rows: AuditRow[]) {
  let seq = head.headSeq;
  let prevHash = head.headHash;
  const values = rows.map((row) => {
    seq += 1;
    const content = { ...row, seq, actorId: row.userId };
    const hash = auditEventHash(prevHash, content);
    const linked = { ...row, actorId: row.userId, seq, prevHash, hash };
    prevHash = hash;
    return linked;
  });
  return { values, headSeq: seq, headHash: prevHash };
}

// ── Running reads inside runInTransaction ─────────────────────────────────

/** `all` returns rows; `run` is a write. */
type Step = { all: unknown } | { run: unknown };

// biome-ignore lint/suspicious/noExplicitAny: builder types are per-dialect
type Builder = any;

/**
 * A statement for runInTransaction that reads before it writes. One generator drives both
 * dialects: bun:sqlite's `.all()`/`.run()` synchronously, PostgreSQL's builders awaited.
 */
function readingStep(
  body: () => Generator<Step, void, unknown[]>,
): PromiseLike<void> & { run: () => void } {
  return {
    run() {
      const steps = body();
      let next = steps.next([]);
      while (!next.done) {
        const step = next.value;
        if ("all" in step) {
          next = steps.next((step.all as Builder).all());
        } else {
          (step.run as Builder).run();
          next = steps.next([]);
        }
      }
    },
    // biome-ignore lint/suspicious/noThenProperty: runInTransaction awaits PostgreSQL statements
    then(onFulfilled, onRejected) {
      return (async () => {
        const steps = body();
        let next = steps.next([]);
        while (!next.done) {
          const step = next.value;
          const result = await ("all" in step ? step.all : step.run);
          next = steps.next(Array.isArray(result) ? result : []);
        }
      })().then(onFulfilled, onRejected);
    },
  };
}

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
        .values({
          id: HEAD_ID,
          headSeq: 0,
          headHash: GENESIS_HASH,
          anchorSeq: 0,
          anchorHash: GENESIS_HASH,
          legacyMaxId: 0,
          updatedAt: nowIso(),
        })
        .onConflictDoNothing(),
    };
    [head] = (yield { all: select() }) as Head[];
  }
  return head as Head;
}

/** Use in place of `tx.insert(auditEvents)`: the rows join the chain in this transaction. */
export function chainedAuditInsert(tx: Builder, rows: AuditRow[]) {
  return readingStep(function* () {
    if (rows.length === 0) return;
    const head = yield* lockHead(tx);
    const linked = linkAuditRows(head, rows);
    yield { run: tx.insert(auditEvents).values(linked.values) };
    yield {
      run: tx
        .update(auditChain)
        .set({ headSeq: linked.headSeq, headHash: linked.headHash, updatedAt: nowIso() })
        .where(eq(auditChain.id, HEAD_ID)),
    };
  });
}

/**
 * Re-derives the head and the anchor from the events present, after something replaced or trimmed
 * them on purpose (a restore, an import, retention). `adoptUnchained` also accepts events with no
 * hash as predating the chain, which only a restore or an import of older history should do.
 */
export async function reanchorAuditChain(options: { adoptUnchained?: boolean } = {}) {
  await runInTransaction((tx) => [
    readingStep(function* () {
      const head = yield* lockHead(tx);
      const [oldest] = (yield {
        all: tx
          .select({ seq: auditEvents.seq, prevHash: auditEvents.prevHash })
          .from(auditEvents)
          .where(isNotNull(auditEvents.seq))
          .orderBy(asc(auditEvents.seq))
          .limit(1),
      }) as { seq: number; prevHash: string }[];
      const [newest] = (yield {
        all: tx
          .select({ seq: auditEvents.seq, hash: auditEvents.hash })
          .from(auditEvents)
          .where(isNotNull(auditEvents.seq))
          .orderBy(desc(auditEvents.seq))
          .limit(1),
      }) as { seq: number; hash: string }[];
      const [unchained] = (yield {
        all: tx
          .select({ id: max(auditEvents.id) })
          .from(auditEvents)
          .where(isNull(auditEvents.seq)),
      }) as { id: number | null }[];

      const next =
        oldest && newest
          ? {
              headSeq: newest.seq,
              headHash: newest.hash,
              anchorSeq: oldest.seq - 1,
              anchorHash: oldest.prevHash,
            }
          : // Nothing chained left: the next event links to where the head already is.
            {
              headSeq: head.headSeq,
              headHash: head.headHash,
              anchorSeq: head.headSeq,
              anchorHash: head.headHash,
            };
      const legacyMaxId = options.adoptUnchained
        ? Math.max(head.legacyMaxId, Number(unchained?.id ?? 0))
        : head.legacyMaxId;
      yield {
        run: tx
          .update(auditChain)
          .set({ ...next, legacyMaxId, updatedAt: nowIso() })
          .where(eq(auditChain.id, HEAD_ID)),
      };
    }),
  ]);
}

/** Retention: drops events older than `beforeIso` and anchors the chain at the oldest kept one. */
export async function pruneAuditEvents(beforeIso: string): Promise<number> {
  const [cut] = await db
    .select({ seq: max(auditEvents.seq) })
    .from(auditEvents)
    .where(and(isNotNull(auditEvents.seq), lt(auditEvents.createdAt, beforeIso)));
  const throughSeq = cut?.seq ?? null;
  const deleted = await db
    .delete(auditEvents)
    .where(
      throughSeq === null
        ? and(isNull(auditEvents.seq), lt(auditEvents.createdAt, beforeIso))
        : // By seq, not time: a clock step back must not leave a hole in the middle of the chain.
          lt(auditEvents.seq, throughSeq + 1),
    )
    .returning({ id: auditEvents.id });
  await reanchorAuditChain();
  return deleted.length;
}

// ── Verify ──────────────────────────────────────────────────────────────────

export type AuditChainBreak = {
  /**
   * missing: an event in the sequence is gone; link: an event does not follow the one before it;
   * content: an event was changed after it was written; head: the chain ends somewhere other than
   * where the last write left it (newest events removed); unchained: an event was added outside the chain.
   */
  reason: "missing" | "link" | "content" | "head" | "unchained";
  seq: number | null;
  eventId: number | null;
};

export type AuditChainVerification = {
  ok: boolean;
  /** Chained events checked. */
  checked: number;
  /** Events written before the chain existed, which it does not cover. */
  legacy: number;
  firstBroken: AuditChainBreak | null;
  verifiedAt: string;
};

export async function verifyAuditChain(): Promise<AuditChainVerification> {
  const verifiedAt = nowIso();
  const [head] = await db.select().from(auditChain).where(eq(auditChain.id, HEAD_ID));
  const anchor = head ?? {
    headSeq: 0,
    headHash: GENESIS_HASH,
    anchorSeq: 0,
    anchorHash: GENESIS_HASH,
    legacyMaxId: 0,
  };
  const result = (checked: number, legacy: number, firstBroken: AuditChainBreak | null) => ({
    ok: firstBroken === null,
    checked,
    legacy,
    firstBroken,
    verifiedAt,
  });

  const [unchained] = await db
    .select({ first: min(auditEvents.id) })
    .from(auditEvents)
    .where(and(isNull(auditEvents.seq), gt(auditEvents.id, anchor.legacyMaxId)));
  const [legacy] = await db
    .select({ value: count() })
    .from(auditEvents)
    .where(isNull(auditEvents.seq));

  let expected = anchor.anchorSeq + 1;
  let prev = anchor.anchorHash;
  let checked = 0;
  let broken: AuditChainBreak | null = null;
  outer: for (;;) {
    const page = await db
      .select()
      .from(auditEvents)
      .where(gt(auditEvents.seq, expected - 1))
      .orderBy(asc(auditEvents.seq))
      .limit(VERIFY_PAGE);
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
      if (auditEventHash(prev, { ...row, seq }) !== row.hash) {
        broken = { reason: "content", seq, eventId: row.id };
        break outer;
      }
      prev = row.hash;
      expected += 1;
      checked += 1;
    }
    if (page.length < VERIFY_PAGE) break;
  }
  if (!broken && (expected - 1 !== anchor.headSeq || prev !== anchor.headHash)) {
    broken = { reason: "head", seq: expected, eventId: null };
  }
  if (!broken && unchained?.first != null) {
    broken = { reason: "unchained", seq: null, eventId: Number(unchained.first) };
  }
  return result(checked, Number(legacy?.value ?? 0), broken);
}
