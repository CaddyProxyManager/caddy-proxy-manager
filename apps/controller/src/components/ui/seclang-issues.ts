"use client";

import { useTranslations } from "next-intl";
import { useDeferredValue, useMemo } from "react";
import { directivePolicyIssues } from "@/lib/waf/caddy";
import { type SeclangLintOptions, lintSeclang } from "@/lib/waf/seclang";
import type { CodeEditorIssue } from "./CodeEditor";

export type SeclangIssueOptions = SeclangLintOptions & {
  /** The global WAF setting: risky lines are errors with it, warnings without. */
  strictDirectives?: boolean;
};

/**
 * What the save-time linter and directive filter will say about `text`, worded for the editor.
 * Deferred, so a long rule list is re-linted when typing pauses rather than on every keystroke.
 */
export function useSeclangIssues(
  text: string,
  options: SeclangIssueOptions = {},
): CodeEditorIssue[] {
  const t = useTranslations("errors");
  const deferred = useDeferredValue(text);
  const { crsLoaded, strictDirectives } = options;
  return useMemo(
    () =>
      [
        ...lintSeclang(deferred, { crsLoaded }),
        ...directivePolicyIssues(deferred, { crsLoaded, strictDirectives }),
      ]
        .sort((a, b) => a.line - b.line)
        .map((issue) => ({
          line: issue.line,
          severity: issue.severity,
          message: t(issue.code, issue.params),
        })),
    [deferred, crsLoaded, strictDirectives, t],
  );
}
