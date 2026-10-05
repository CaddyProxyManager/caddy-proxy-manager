"use client";

import { useTranslations } from "next-intl";
import { useDeferredValue, useMemo } from "react";
import { type SeclangLintOptions, lintSeclang } from "@/lib/waf/seclang";
import type { CodeEditorIssue } from "./CodeEditor";

/**
 * What the save-time linter will say about `text`, worded for the editor. Deferred, so a long rule
 * list is re-linted when typing pauses rather than on every keystroke.
 */
export function useSeclangIssues(
  text: string,
  options: SeclangLintOptions = {},
): CodeEditorIssue[] {
  const t = useTranslations("errors");
  const deferred = useDeferredValue(text);
  const { crsLoaded } = options;
  return useMemo(
    () =>
      lintSeclang(deferred, { crsLoaded }).map((issue) => ({
        line: issue.line,
        severity: issue.severity,
        message: t(issue.code, issue.params),
      })),
    [deferred, crsLoaded, t],
  );
}
