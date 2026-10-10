/**
 * A LIKE that takes the needle literally. Both dialects read `%` and `_` as wildcards, and SQLite
 * has no escape character unless the clause names one, so the clause always does.
 */
import { type SQL, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

export function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/** `column LIKE '%needle%'`, with the needle's own wildcards escaped. */
export function likeContains(column: AnyColumn | SQL, needle: string): SQL {
  return sql`${column} LIKE ${`%${escapeLikePattern(needle)}%`} ESCAPE '\\'`;
}
