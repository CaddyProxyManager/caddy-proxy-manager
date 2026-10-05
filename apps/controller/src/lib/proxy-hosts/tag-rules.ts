/** Split out so the editor's chip input can check a tag without pulling in the error catalog. */

export const HOST_TAG_MAX_LENGTH = 40;
export const HOST_TAGS_MAX = 16;

/** No quote, backslash or `%`, so a tag matches inside the stored JSON with a plain LIKE. */
const HOST_TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u;

/** How a tag is stored: trimmed and lowercased. */
export function hostTagText(value: string): string {
  return value.trim().toLowerCase();
}

/** Of an already normalised tag; null when it may be stored. Length counts code points. */
export function hostTagProblem(tag: string): "invalid" | "tooLong" | null {
  if (!HOST_TAG_PATTERN.test(tag)) return "invalid";
  if ([...tag].length > HOST_TAG_MAX_LENGTH) return "tooLong";
  return null;
}
