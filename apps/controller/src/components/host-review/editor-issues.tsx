"use client";
/**
 * What the editor's own validators found, summed for the frame: a field with a linter (the WAF
 * directives, say) reports its counts here, and the toolbar says how many errors and warnings the
 * save would meet before the review even opens.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type EditorIssueCounts = { errors: number; warnings: number };

type Report = (id: string, counts: EditorIssueCounts | null) => void;

const NONE: EditorIssueCounts = { errors: 0, warnings: 0 };
const ReportContext = createContext<Report | null>(null);
const TotalsContext = createContext<EditorIssueCounts>(NONE);

export function EditorIssuesProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<ReadonlyMap<string, EditorIssueCounts>>(new Map());
  const report = useCallback<Report>((id, next) => {
    setCounts((prev) => {
      const current = prev.get(id);
      const same = next
        ? current?.errors === next.errors && current?.warnings === next.warnings
        : current === undefined;
      if (same) return prev;
      const copy = new Map(prev);
      if (next) copy.set(id, next);
      else copy.delete(id);
      return copy;
    });
  }, []);
  const totals = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const entry of counts.values()) {
      errors += entry.errors;
      warnings += entry.warnings;
    }
    return { errors, warnings };
  }, [counts]);
  return (
    <ReportContext.Provider value={report}>
      <TotalsContext.Provider value={totals}>{children}</TotalsContext.Provider>
    </ReportContext.Provider>
  );
}

/** For a field that lints itself. Outside an editor frame (the WAF page) it reports to nobody. */
export function useReportEditorIssues(
  id: string,
  issues: readonly { severity: "error" | "warning" }[],
): void {
  const report = useContext(ReportContext);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  useEffect(() => {
    report?.(id, { errors, warnings });
  }, [report, id, errors, warnings]);
  useEffect(() => () => report?.(id, null), [report, id]);
}

export function useEditorIssueTotals(): EditorIssueCounts {
  return useContext(TotalsContext);
}
