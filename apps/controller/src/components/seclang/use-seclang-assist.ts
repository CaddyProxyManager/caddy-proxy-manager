"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import type { CodeAssist } from "@/components/ui/CodeEditor";
import { seclangCompletions, seclangTermAt } from "@/lib/waf/seclang-assist";
import { referenceKey, type SeclangTermKind } from "@/lib/waf/seclang-reference";

type Translator = ReturnType<typeof useTranslations<"seclang">>;
type Key = Parameters<Translator>[0];

/** What a SecLang term does, from the catalog; undefined for a name it has no entry for. */
export function useTermDescription(): (kind: SeclangTermKind, name: string) => string | undefined {
  const t = useTranslations("seclang");
  return useCallback(
    (kind, name) => {
      const key = `reference.${kind}.${referenceKey(name)}` as Key;
      return t.has(key) ? t(key) : undefined;
    },
    [t],
  );
}

/** Completions and hover help for the SecLang text editor. */
export function useSeclangAssist(): CodeAssist {
  const t = useTranslations("seclang");
  const describe = useTermDescription();
  return useMemo(
    () => ({
      hint: t("assistHint"),
      listLabel: t("completionsLabel"),
      complete: (text, caret) => {
        const result = seclangCompletions(text, caret);
        return (
          result && {
            ...result,
            items: result.items.map((item) => ({
              label: item.label,
              insert: item.insert,
              kind: t(`kinds.${item.slot}`),
              description: item.term && describe(item.term, item.label),
            })),
          }
        );
      },
      describe: (text, offset) => {
        const term = seclangTermAt(text, offset);
        const description = term && describe(term.kind, term.name);
        return term && description
          ? { title: term.name, kind: t(`kinds.${term.kind}`), description }
          : null;
      },
    }),
    [t, describe],
  );
}
