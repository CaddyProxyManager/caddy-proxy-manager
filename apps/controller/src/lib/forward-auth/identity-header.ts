const encoder = new TextEncoder();

/**
 * Values of the X-CPM-* identity headers. Anything outside printable ASCII, and "%" itself, is
 * percent-encoded as UTF-8, so no user or group name can make Headers throw; `reserved` characters
 * are encoded too. A plain ASCII value without "%" is sent unchanged.
 */
export function encodeIdentityHeaderValue(value: string, reserved = ""): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e && ch !== "%" && !reserved.includes(ch)) {
      out += ch;
      continue;
    }
    // A lone surrogate encodes as U+FFFD rather than throwing, unlike encodeURIComponent.
    for (const byte of encoder.encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Comma-joined, with commas inside a name encoded so "admins,ops" never reads as two groups. */
export function encodeGroupsHeaderValue(names: string[]): string {
  return names.map((name) => encodeIdentityHeaderValue(name, ",")).join(",");
}
