import { requireCan } from "@/src/lib/users/permissions";
import { recentRevisions } from "@/src/lib/settings/apply";
import {
  compareRevisions,
  countRevisions,
  oldestRestorable,
  previousRevisionId,
  revisionExists,
  revisionIds,
} from "@/src/lib/settings/revisions";
import { stagedView } from "@/src/lib/settings/staged-view";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import HistoryClient from "./HistoryClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("history.title") };
}

const PER_PAGE = 20;

function readId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The selection is in the query string so a comparison is a shareable link; the diff renders here
 * because it needs the config builder, which only runs on the server.
 */
export default async function SettingsHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCan("settings:read");
  const params = await searchParams;

  const [staged, total, ids, restorableFrom] = await Promise.all([
    stagedView(Number(session.user.id)),
    countRevisions(),
    revisionIds(),
    oldestRestorable(),
  ]);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(readId(params.page) ?? 1, 1), pages);
  const revisions = await recentRevisions(PER_PAGE, (page - 1) * PER_PAGE);

  const latest = ids[0] ?? 0;
  // Checked against the table, not `ids`, which is capped and would lose an older revision's link.
  const to = readId(params.to) ?? latest;
  const from = readId(params.from) ?? (await previousRevisionId(to));
  const [toExists, fromExists] = await Promise.all([
    revisionExists(to),
    from === 0 ? true : revisionExists(from),
  ]);
  const valid = toExists && fromExists && from !== to;
  const comparison = valid ? await compareRevisions(from, to) : null;

  return (
    <HistoryClient
      staged={staged}
      revisions={revisions}
      page={page}
      perPage={PER_PAGE}
      total={total}
      ids={ids}
      latest={latest}
      restorableFrom={restorableFrom}
      selection={latest > 0 ? { from, to } : null}
      comparison={comparison}
    />
  );
}
