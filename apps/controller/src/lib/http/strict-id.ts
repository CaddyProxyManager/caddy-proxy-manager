/**
 * A query-string id, or undefined. Digits only: parseInt would read "942100x" as 942100 and filter
 * on an id nobody asked for.
 */
export function strictId(value: string | undefined): number | undefined {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return undefined;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) ? id : undefined;
}
