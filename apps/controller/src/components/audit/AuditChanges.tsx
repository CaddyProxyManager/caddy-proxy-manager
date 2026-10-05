"use client";

import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Table, type TableColumn, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useTranslations } from "next-intl";
import { formatDiffValue } from "@/components/host-review/ReviewChangesDialog";
import type { AuditChange } from "@/lib/audit/changes";
import type { DiffValue } from "@/lib/host-review/types";

export type DiffLayout = "unified" | "split";

type Row = { id: string; field: string; path: string | null; before: DiffValue; after: DiffValue };

function rowsOf(changes: AuditChange[]): Row[] {
  return changes.flatMap((change): Row[] =>
    change.leaves
      ? change.leaves.map((leaf) => ({
          id: `${change.field}.${leaf.path}`,
          field: change.field,
          path: leaf.path,
          before: leaf.before,
          after: leaf.after,
        }))
      : [
          {
            id: change.field,
            field: change.field,
            path: null,
            before: change.before,
            after: change.after,
          },
        ],
  );
}

function Side({ sign, value }: { sign: "-" | "+"; value: string }) {
  return (
    <HStack gap={2} vAlign="start">
      <Token size="sm" label={sign} color={sign === "-" ? "red" : "green"} />
      <Text type="code" size="sm" wordBreak="break-word">
        {value}
      </Text>
    </HStack>
  );
}

/** An audit event's before and after, one line pair per field, or as two columns. */
export function AuditChanges({ changes, layout }: { changes: AuditChange[]; layout: DiffLayout }) {
  const t = useTranslations("auditLog");
  const tCommon = useTranslations("common");
  const tReview = useTranslations("hostReview");
  const hostField = (field: string) => `fields.${field}` as Parameters<typeof tReview>[0];
  // Host fields read in words; anything else is the stored column name, as resources are.
  const label = (row: Pick<Row, "field" | "path">) => {
    const field = tReview.has(hostField(row.field)) ? tReview(hostField(row.field)) : row.field;
    return row.path ? t("changePath", { field, path: row.path }) : field;
  };
  const show = (row: Row, value: DiffValue) =>
    formatDiffValue(row.path ?? row.field, value, tReview);
  const rows = rowsOf(changes);

  if (layout === "split") {
    const columns: TableColumn<Row>[] = [
      {
        key: "field",
        header: t("diffField"),
        width: pixel(200),
        renderCell: (row) => (
          <Text type="body" size="sm" wordBreak="break-word">
            {label(row)}
          </Text>
        ),
      },
      {
        key: "before",
        header: tCommon("before"),
        width: proportional(1),
        renderCell: (row) => (
          <Text type="code" size="sm" wordBreak="break-word">
            {show(row, row.before)}
          </Text>
        ),
      },
      {
        key: "after",
        header: tCommon("after"),
        width: proportional(1),
        renderCell: (row) => (
          <Text type="code" size="sm" wordBreak="break-word">
            {show(row, row.after)}
          </Text>
        ),
      },
    ];
    return <Table data={rows} columns={columns} idKey="id" density="compact" />;
  }

  return (
    <List density="compact" hasDividers>
      {rows.map((row) => (
        <ListItem
          key={row.id}
          label={label(row)}
          description={
            <VStack gap={1}>
              <Side sign="-" value={show(row, row.before)} />
              <Side sign="+" value={show(row, row.after)} />
            </VStack>
          }
        />
      ))}
    </List>
  );
}
