/** What a host's history page renders, read from its query string. Shared by both host kinds. */

import {
  compareHostRevisions,
  countHostRevisions,
  getHostRevision,
  hostRevisionIds,
  listHostRevisions,
  missingReferences,
  previousHostRevisionId,
} from ".";
import type { HostKind, HostRevisionSummary, MissingReference } from "./types";

const PER_PAGE = 20;

type Params = Record<string, string | string[] | undefined>;

function readId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

export type HostHistoryData = {
  revisions: HostRevisionSummary[];
  page: number;
  perPage: number;
  total: number;
  ids: number[];
  latest: number;
  /** The host's name in its latest revision, for a deleted host's heading. */
  name: string | null;
  selection: { from: number; to: number } | null;
  comparison: Awaited<ReturnType<typeof compareHostRevisions>>;
  showConfig: boolean;
  /** What the selected revision names that is gone, for the restore dialog. */
  missing: MissingReference[];
};

export async function loadHostHistory(
  kind: HostKind,
  hostId: number,
  params: Params,
): Promise<HostHistoryData> {
  const [total, ids] = await Promise.all([
    countHostRevisions(kind, hostId),
    hostRevisionIds(kind, hostId),
  ]);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(readId(params.page) ?? 1, 1), pages);
  const revisions = await listHostRevisions(kind, hostId, PER_PAGE, (page - 1) * PER_PAGE);
  const latest = ids[0] ?? 0;
  const showConfig = params.config === "1";

  if (latest === 0) {
    return {
      revisions,
      page,
      perPage: PER_PAGE,
      total,
      ids,
      latest,
      name: null,
      selection: null,
      comparison: null,
      showConfig,
      missing: [],
    };
  }

  const to = readId(params.to) ?? latest;
  const from = readId(params.from) ?? (await previousHostRevisionId(kind, hostId, to));
  const [target, newest] = await Promise.all([getHostRevision(to), getHostRevision(latest)]);
  const comparison =
    from !== to ? await compareHostRevisions(kind, hostId, from, to, { config: showConfig }) : null;
  const missing =
    target && target.hostKind === kind && target.hostId === hostId
      ? await missingReferences(kind, target.snapshot)
      : [];
  return {
    revisions,
    page,
    perPage: PER_PAGE,
    total,
    ids,
    latest,
    name: newest?.name ?? null,
    selection: { from, to },
    comparison,
    showConfig,
    missing,
  };
}
