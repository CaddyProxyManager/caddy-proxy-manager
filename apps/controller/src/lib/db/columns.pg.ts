import { customType } from "drizzle-orm/pg-core";

/**
 * ISO-8601 TEXT that accepts a Date: Better Auth's adapter writes Dates, which bun:sqlite rejects
 * (failing every sign-in) while Bun.SQL serializes them. Storage is still TEXT; no migration.
 */
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  // Wider than the column's `string` on purpose: the values needing this are exactly the Dates.
  toDriver: (value: string | Date) => (value instanceof Date ? value.toISOString() : value),
});
