/**
 * How a reader likes numbers grouped, independent of the language they read in. Each choice is a
 * locale whose digits Intl groups that way; "auto" keeps the language's own. No server imports.
 */
export const NUMBER_FORMATS = [
  "auto",
  "comma-dot",
  "dot-comma",
  "space-comma",
  "apostrophe-dot",
] as const;

export type NumberFormatPreference = (typeof NUMBER_FORMATS)[number];

const NUMBER_LOCALES: Record<Exclude<NumberFormatPreference, "auto">, string> = {
  "comma-dot": "en-US",
  "dot-comma": "de-DE",
  "space-comma": "fr-FR",
  "apostrophe-dot": "de-CH",
};

export function isNumberFormatPreference(value: unknown): value is NumberFormatPreference {
  return (NUMBER_FORMATS as readonly unknown[]).includes(value);
}

/** Null for "auto": the page's own locale formats numbers, as before there was a choice. */
export function numberLocaleFor(preference: string | null | undefined): string | null {
  return isNumberFormatPreference(preference) && preference !== "auto"
    ? NUMBER_LOCALES[preference]
    : null;
}
