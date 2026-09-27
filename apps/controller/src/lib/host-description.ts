import { domainError } from "./domain-error";
import { HOST_DESCRIPTION_MAX_LENGTH } from "./host-description-limit";

// Graphemes, the way the editor's counter counts, so an emoji can't pass one and fail the other.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A host's free-text notes as stored: `undefined` leaves them alone, and blank clears them. Capped
 * so the column can't be used to park megabytes in every host listing.
 */
export function normalizeHostDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  let count = 0;
  for (const _ of graphemes.segment(text)) count++;
  if (count > HOST_DESCRIPTION_MAX_LENGTH) {
    throw domainError(
      "hostDescriptionTooLong",
      { max: HOST_DESCRIPTION_MAX_LENGTH },
      { status: 400 },
    );
  }
  return text;
}
