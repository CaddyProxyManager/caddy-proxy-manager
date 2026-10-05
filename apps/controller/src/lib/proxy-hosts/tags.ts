import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { domainError } from "../errors/domain-error";
import { HOST_TAG_MAX_LENGTH, HOST_TAGS_MAX, hostTagProblem, hostTagText } from "./tag-rules";

function sortedUnique(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort();
}

/**
 * A host's tags as stored: lowercased, trimmed, deduplicated and sorted. `undefined` leaves them
 * alone and null clears them; anything else that is not a list of valid tags is refused.
 */
export function normalizeHostTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    throw domainError("hostTagsInvalid", {}, { status: 400 });
  }
  const tags = sortedUnique((value as string[]).map(hostTagText).filter(Boolean));
  for (const tag of tags) {
    const problem = hostTagProblem(tag);
    if (problem === "invalid") throw domainError("hostTagInvalid", { tag }, { status: 400 });
    if (problem === "tooLong") {
      throw domainError("hostTagTooLong", { tag, max: HOST_TAG_MAX_LENGTH }, { status: 400 });
    }
  }
  if (tags.length > HOST_TAGS_MAX) {
    throw domainError("hostTooManyTags", { max: HOST_TAGS_MAX }, { status: 400 });
  }
  return tags;
}

/** The stored column; a row written before tags existed, or by hand, reads as none. */
export function parseStoredTags(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/** Adds to what a host has; the result is checked whole, so a full host refuses the batch. */
export function withHostTags(stored: string | null | undefined, added: string[]): string {
  return JSON.stringify(normalizeHostTags([...parseStoredTags(stored), ...added]));
}

/**
 * Hosts carrying exactly `tag`. `_` is a LIKE wildcard and a valid tag character, hence the
 * escape; SQLite has no default escape character, so it is named.
 */
export function hasTagClause(column: SQLWrapper, tag: string): SQL {
  const escaped = hostTagText(tag).replace(/[\\%_]/g, (char) => `\\${char}`);
  return sql`${column} LIKE ${`%"${escaped}"%`} ESCAPE '\\'`;
}

/** Every tag in use across `rows`, for the list's filter. */
export function collectTags(rows: { tags: string | null }[]): string[] {
  return sortedUnique(rows.flatMap((row) => parseStoredTags(row.tags)));
}
