import type { ReactNode } from "react";
import { HStack } from "@astryxdesign/core/Stack";
import { PageHeader, type PageHeaderProps } from "./PageHeader";

/**
 * `display: contents` on desktop, so the parts keep the page stack's gaps. On a phone title,
 * search and filters stick; stat tiles are dropped (they push rows off screen) and the summary
 * scrolls away with the rows.
 */
export function ListPageHeader({
  stats,
  summary,
  filters,
  search,
  bulkBar,
  ...header
}: PageHeaderProps & {
  stats?: ReactNode;
  summary?: ReactNode;
  filters?: ReactNode;
  search?: ReactNode;
  /** Takes the filters row's place while rows are selected. */
  bulkBar?: ReactNode;
}) {
  return (
    <>
      <div className="cpm-list-header">
        <PageHeader {...header} />
        {stats && <div className="cpm-desktop-only">{stats}</div>}
        {summary && <div className="cpm-desktop-only">{summary}</div>}
        {bulkBar ? (
          <div className="cpm-list-toolbar">{bulkBar}</div>
        ) : (
          (filters || search) && (
            <HStack
              gap={4}
              vAlign="center"
              wrap="wrap"
              justify="between"
              className="cpm-list-toolbar"
            >
              {filters && <div className="cpm-list-filters">{filters}</div>}
              {search && <div className="cpm-list-search">{search}</div>}
            </HStack>
          )
        )}
      </div>
      {summary && <div className="cpm-mobile-only">{summary}</div>}
    </>
  );
}
