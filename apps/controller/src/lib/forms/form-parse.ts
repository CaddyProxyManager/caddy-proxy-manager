/** Pure FormData parsing helpers shared by the host forms - no DB or network. */

export function parseCsv(value: FormDataEntryValue | null): string[] {
  if (!value || typeof value !== "string") return [];
  return value
    .replace(/\n/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Newline only: a URL's query string may contain commas. */
export function parseUpstreams(value: FormDataEntryValue | null): string[] {
  if (!value || typeof value !== "string") return [];
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseCheckbox(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

export function parseOptionalText(value: FormDataEntryValue | null): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseCertificateId(value: FormDataEntryValue | null): number | null {
  if (!value || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

export function parseAccessListId(value: FormDataEntryValue | null): number | null {
  if (!value || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

export function parseOptionalNumber(value: FormDataEntryValue | null): number | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return num;
}

/** One `tag` field per chip. Undefined without the `tagsPresent` marker, so a save keeps them. */
export function parseHostTags(formData: FormData): string[] | undefined {
  if (!formData.has("tagsPresent")) return undefined;
  return formData.getAll("tag").filter((value): value is string => typeof value === "string");
}
