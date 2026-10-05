/**
 * Client-side identity for editable-list rows. Keying on the array index made React reconcile a
 * deleted row's DOM node onto its successor, so uncommitted input state surfaced in the wrong row.
 * The ids are render-only, never part of the serialized payload.
 */

let fallbackCounter = 0;

/** Mints an id unique within the page. */
export function newRowId(): string {
  // randomUUID is only exposed in a secure context, which a plain-HTTP LAN install is not. The
  // counter covers that case: ids need to be unique among the rows on one page, not globally.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `row-${fallbackCounter}`;
}

export type WithRowId<T> = T & { rowId: string };

/** Tags one freshly created row with an id. */
export function withRowId<T extends object>(value: T): WithRowId<T> {
  return { ...value, rowId: newRowId() };
}

/** Tags rows seeded from server data, e.g. in a `useState` initializer. */
export function withRowIds<T extends object>(values: readonly T[]): WithRowId<T>[] {
  return values.map(withRowId);
}
