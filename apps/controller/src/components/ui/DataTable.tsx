"use client";

import {
  type Dispatch,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronRight } from "lucide-react";
import {
  Table,
  pixel,
  proportional,
  useTableRowExpansion,
  useTableRowStatus,
  useTableSelection,
  useTableSelectionState,
  type TableColumn,
  type TablePlugin,
  type TableRowStatus,
} from "@astryxdesign/core/Table";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { VStack } from "@astryxdesign/core/Stack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useTranslations } from "next-intl";
import { useTableDensity } from "./TableDensity";

export type Column<T> = {
  id: string;
  label: string;
  align?: "left" | "right" | "center";
  width?: string | number;
  sortKey?: string;
  render?: (row: T) => ReactNode;
};

export type { TableRowStatus };

/** Row shape Astryx's Table works in; see the note in DataTable below. */
type TableRow = Record<string, unknown>;

/** Row checkboxes over the rendered page. The set is the caller's, so a bulk bar can read it. */
export type RowSelection<T> = {
  selectedKeys: Set<string>;
  onChange: Dispatch<SetStateAction<Set<string>>>;
  /** A row that fails this shows a disabled checkbox, e.g. a host an operator may only view. */
  isRowSelectable?: (row: T) => boolean;
  /** Names the row to a screen reader: "Select <label>". */
  rowLabel?: (row: T) => string;
};

/**
 * Selection state for one page of `rows`. Cleared whenever the query string changes (page,
 * filter, search, sort), so a bulk action never reaches a row the reader cannot see, and pruned
 * to the rows still present after a refresh.
 */
export function useRowSelection<T>(
  rows: T[],
  keyField: keyof T,
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const query = useSearchParams().toString();
  useEffect(() => {
    void query;
    setSelected(new Set());
  }, [query]);
  const present = rows.map((row) => String(row[keyField])).join(",");
  useEffect(() => {
    const keys = new Set(present.split(","));
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => keys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [present]);
  return [selected, setSelected];
}

type DataTableProps<T> = {
  columns: Column<T>[];
  data: T[];
  keyField: keyof T;
  emptyMessage?: string;
  /** The empty state heading sits under the page h1 unless the table is in a titled section. */
  emptyHeadingLevel?: 2 | 3 | 4;
  loading?: boolean;
  /** Renders a trailing "open" control on each row, rather than a bare row click. */
  onRowClick?: (row: T) => void;
  /**
   * A click on the row's background opens this page. Give the row a link of its own too (its
   * name, say): a row click is unreachable from the keyboard.
   */
  rowHref?: (row: T) => string;
  rowStatus?: (row: T) => TableRowStatus | null;
  pagination?: {
    total: number;
    page: number;
    perPage: number;
  };
  sort?: { sortBy: string; sortDir: "asc" | "desc" };
  mobileCard?: (row: T) => ReactNode;
  /** Detail panel below an expanded row; adds the chevron column. The open set is owned here. */
  expandedRow?: (row: T) => ReactNode;
  /** With expandedRow: a click anywhere on the row toggles it, not only the chevron. */
  expandOnRowClick?: boolean;
  /** Adds the checkbox column. Desktop only: the phone cards have no selection. */
  selection?: RowSelection<T>;
};

// Fixed keys, so the skeletons need no index keys.
const SKELETON_ROW_KEYS = ["row-1", "row-2", "row-3", "row-4", "row-5"];
const SKELETON_CARD_KEYS = ["card-1", "card-2", "card-3"];

const ALIGN: Record<NonNullable<Column<unknown>["align"]>, "start" | "center" | "end"> = {
  left: "start",
  center: "center",
  right: "end",
};

/** Astryx's cell and wrapper padding clip the chevron in a 40px column; widened, cell unpadded. */
const EXPANSION_COLUMN = "__expansion";
const EXPANSION_COLUMN_WIDTH = pixel(48);

/** A click that lands on a control inside the row belongs to that control, not the row. */
function isInteractiveTarget(event: MouseEvent): boolean {
  return (
    (event.target as HTMLElement).closest(
      'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"]',
    ) !== null
  );
}

function toColumnWidth(width: Column<unknown>["width"]) {
  if (typeof width === "number") return pixel(width);
  if (typeof width === "string") {
    const parsed = Number.parseInt(width, 10);
    if (Number.isFinite(parsed)) return pixel(parsed);
  }
  return proportional(1);
}

function PaginationBar({ page, perPage, total }: { page: number; perPage: number; total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (Math.ceil(total / perPage) <= 1) return null;

  return (
    <Pagination
      page={page}
      pageSize={perPage}
      totalItems={total}
      onChange={(nextPage) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("page", String(nextPage));
        router.push(`${pathname}?${params.toString()}`);
      }}
    />
  );
}

/** Sorting is server-side, so the heading just pushes a new URL. */
function SortableHeader<T>({
  col,
  sort,
}: {
  col: Column<T>;
  sort?: { sortBy: string; sortDir: "asc" | "desc" };
}) {
  const tCommon = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // A column with no visible title still needs one for a screen reader.
  if (!col.label) return <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>;
  if (!col.sortKey) return <>{col.label}</>;

  const isActive = sort?.sortBy === col.sortKey;
  const nextDir = isActive && sort?.sortDir === "asc" ? "desc" : "asc";

  return (
    <Button
      variant="ghost"
      size="sm"
      label={col.label}
      endContent={
        isActive ? sort?.sortDir === "asc" ? <ArrowUp /> : <ArrowDown /> : <ArrowUpDown />
      }
      onClick={() => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("sortBy", col.sortKey!);
        params.set("sortDir", nextDir);
        params.set("page", "1");
        router.push(`${pathname}?${params.toString()}`);
      }}
    />
  );
}

export function DataTable<T>({
  columns,
  data,
  keyField,
  emptyMessage,
  emptyHeadingLevel = 2,
  loading = false,
  onRowClick,
  rowHref,
  rowStatus,
  pagination,
  sort,
  mobileCard,
  expandedRow,
  expandOnRowClick = false,
  selection,
}: DataTableProps<T>) {
  const t = useTranslations("ui");
  const tCommon = useTranslations("common");
  const emptyTitle = emptyMessage ?? t("noDataAvailable");
  const isEmpty = data.length === 0 && !loading;
  // A query rather than CSS, so only one of the two views is ever mounted.
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const density = useTableDensity();

  // Astryx's Table wants an index signature; the cast stays here rather than on every model.
  const getStatus = useCallback(
    (row: TableRow) => (rowStatus ? rowStatus(row as T) : null),
    [rowStatus],
  );
  const statusPlugin = useTableRowStatus<TableRow>({ getStatus });

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const getRowKey = useCallback((row: TableRow) => String(row[keyField as string]), [keyField]);
  const astryxExpansion = useTableRowExpansion<TableRow>({
    expandedKeys,
    onToggle: toggleExpanded,
    getRowKey,
    renderExpanded: useCallback(
      (row: TableRow) => (expandedRow ? expandedRow(row as T) : null),
      [expandedRow],
    ),
  });

  const expansionPlugin = useMemo(
    (): TablePlugin<TableRow> => ({
      ...astryxExpansion,
      transformColumns: (cols) =>
        (astryxExpansion.transformColumns?.(cols) ?? cols).map((col) =>
          col.key === EXPANSION_COLUMN ? { ...col, width: EXPANSION_COLUMN_WIDTH } : col,
        ),
      transformBodyCell: (props, column, ...rest) => {
        const next = astryxExpansion.transformBodyCell?.(props, column, ...rest) ?? props;
        if (column.key !== EXPANSION_COLUMN) return next;
        return {
          ...next,
          htmlProps: { ...next.htmlProps, style: { ...next.htmlProps.style, paddingInline: 0 } },
        };
      },
      transformBodyRow: (props, row, index) => {
        const next = astryxExpansion.transformBodyRow?.(props, row, index) ?? props;
        if (!expandOnRowClick) return next;
        return {
          ...next,
          htmlProps: {
            ...next.htmlProps,
            style: { ...next.htmlProps.style, cursor: "pointer" },
            onClick: (event) => {
              next.htmlProps.onClick?.(event);
              if (!isInteractiveTarget(event)) toggleExpanded(getRowKey(row));
            },
          },
        };
      },
    }),
    [astryxExpansion, expandOnRowClick, toggleExpanded, getRowKey],
  );

  const router = useRouter();
  const rowLinkPlugin = useMemo(
    (): TablePlugin<TableRow> => ({
      transformBodyRow: (props, row) => {
        if (!rowHref) return props;
        return {
          ...props,
          htmlProps: {
            ...props.htmlProps,
            style: { ...props.htmlProps.style, cursor: "pointer" },
            onClick: (event) => {
              props.htmlProps.onClick?.(event);
              if (isInteractiveTarget(event)) return;
              // Selecting text in a cell is not a request to leave the page.
              if (window.getSelection()?.toString()) return;
              router.push(rowHref(row as T));
            },
          },
        };
      },
    }),
    [rowHref, router],
  );

  // Hooks run unconditionally; without a `selection` prop the fallback set is simply never shown.
  const [fallbackKeys, setFallbackKeys] = useState<Set<string>>(() => new Set());
  const { selectionConfig } = useTableSelectionState<TableRow>({
    data: data as readonly unknown[] as TableRow[],
    idKey: getRowKey,
    selectedKeys: selection?.selectedKeys ?? fallbackKeys,
    setSelectedKeys: selection?.onChange ?? setFallbackKeys,
    getIsItemEnabled: (row) => selection?.isRowSelectable?.(row as T) ?? true,
  });
  const selectionPlugin = useTableSelection<TableRow>({
    ...selectionConfig,
    getRowLabel: selection?.rowLabel ? (row) => selection.rowLabel!(row as T) : undefined,
  });

  const plugins = {
    ...(selection ? { selection: selectionPlugin } : {}),
    ...(rowStatus ? { rowStatus: statusPlugin } : {}),
    ...(expandedRow ? { expansion: expansionPlugin } : {}),
    ...(rowHref && !expandedRow ? { rowLink: rowLinkPlugin } : {}),
  };

  const tableColumns: TableColumn<TableRow>[] = columns.map((col) => ({
    key: col.id,
    header: <SortableHeader col={col} sort={sort} />,
    width: toColumnWidth(col.width),
    align: col.align ? ALIGN[col.align] : undefined,
    renderCell: col.render
      ? (row: TableRow) => col.render!(row as T)
      : (row: TableRow) => row[col.id] as ReactNode,
  }));

  if (onRowClick) {
    // A focusable control: a bare row click is unreachable from the keyboard.
    tableColumns.push({
      key: "__open",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(48),
      align: "end",
      resizable: false,
      renderCell: (row: TableRow) => (
        <IconButton
          variant="ghost"
          size="sm"
          label={t("viewDetails")}
          icon={<ChevronRight />}
          onClick={() => onRowClick(row as T)}
        />
      ),
    });
  }

  if (mobileCard && isNarrow) {
    return (
      <VStack gap={3}>
        {loading ? (
          SKELETON_CARD_KEYS.map((key) => (
            <Card key={key}>
              <Skeleton height={80} />
            </Card>
          ))
        ) : isEmpty ? (
          <Card>
            <EmptyState title={emptyTitle} headingLevel={emptyHeadingLevel} isCompact />
          </Card>
        ) : (
          data.map((row) => <VStack key={String(row[keyField])}>{mobileCard(row)}</VStack>)
        )}
        {pagination && <PaginationBar {...pagination} />}
      </VStack>
    );
  }

  if (isEmpty) {
    return (
      <Card>
        <EmptyState title={emptyTitle} headingLevel={emptyHeadingLevel} />
      </Card>
    );
  }

  return (
    <VStack gap={4}>
      {loading ? (
        <VStack gap={2}>
          {SKELETON_ROW_KEYS.map((key) => (
            <Skeleton key={key} height={40} />
          ))}
        </VStack>
      ) : (
        <Table
          data={data as readonly unknown[] as TableRow[]}
          columns={tableColumns}
          idKey={String(keyField)}
          density={density}
          hasHover
          plugins={Object.keys(plugins).length > 0 ? plugins : undefined}
        />
      )}
      {pagination && <PaginationBar {...pagination} />}
    </VStack>
  );
}
