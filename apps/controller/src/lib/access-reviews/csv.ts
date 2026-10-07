/**
 * A campaign as a spreadsheet: one row per item, with what was decided and what came of it.
 * Kinds, decisions, outcomes and hints stay codes, so a filter keeps working whatever language
 * the file was exported in; the headers, roles and failure reasons are the reader's.
 */
import type { ReviewItem } from "./model";

export const CSV_COLUMNS = [
  "item",
  "kind",
  "subject",
  "target",
  "current",
  "hints",
  "reviewer",
  "decision",
  "changeTo",
  "note",
  "decidedAt",
  "outcome",
  "outcomeReason",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

export type CsvLabels = {
  header: (column: CsvColumn) => string;
  /** A role key as its name; anything else (a grant's view or manage) as it is. */
  value: (kind: ReviewItem["kind"], value: string) => string;
  reason: (code: string) => string;
};

export function campaignCsvRows(
  items: readonly ReviewItem[],
  labels: CsvLabels,
): { header: string[]; rows: (string | number | null)[][] } {
  return {
    header: CSV_COLUMNS.map(labels.header),
    rows: items.map((item) => [
      item.id,
      item.kind,
      item.subjectLabel,
      item.targetLabel,
      item.current === null ? null : labels.value(item.kind, item.current),
      item.hints.join(" "),
      item.reviewerLabel,
      item.decision ?? "undecided",
      item.changeTo === null ? null : labels.value(item.kind, item.changeTo),
      item.note,
      item.decidedAt,
      item.outcome,
      item.outcomeCode ? labels.reason(item.outcomeCode) : null,
    ]),
  };
}
