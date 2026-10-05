"use client";

/**
 * next-intl's formatter with the account's number grouping (lib/locale/number-format.ts) in place
 * of the language's. Dates, times and lists are untouched. Without a provider it is next-intl's
 * own, which is what the docs site's demos get.
 */
import { createContext, type ReactNode, use, useMemo } from "react";
import { useFormatter } from "next-intl";

const NumberLocaleContext = createContext<string | null>(null);

export function NumberLocaleProvider({
  value,
  children,
}: {
  value: string | null;
  children: ReactNode;
}) {
  return <NumberLocaleContext value={value}>{children}</NumberLocaleContext>;
}

type Formatter = ReturnType<typeof useFormatter>;

export function useAppFormatter(): Formatter {
  const format = useFormatter();
  const numberLocale = use(NumberLocaleContext);
  return useMemo(() => {
    if (!numberLocale) return format;
    const cached = new Map<string, Intl.NumberFormat>();
    const number = ((value: number | bigint, options?: Intl.NumberFormatOptions | string) => {
      // A named format is next-intl's to resolve; only plain options are reformatted.
      if (typeof options === "string") return format.number(value, options);
      const key = JSON.stringify(options ?? {});
      let formatter = cached.get(key);
      if (!formatter) {
        formatter = new Intl.NumberFormat(numberLocale, options);
        cached.set(key, formatter);
      }
      return formatter.format(value);
    }) as Formatter["number"];
    return { ...format, number };
  }, [format, numberLocale]);
}
