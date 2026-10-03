/**
 * Everything a typed username passes through before it reaches a directory. Pure, so the escaping
 * is tested on its own: a filter or DN built by interpolation is how LDAP injection happens.
 */
import { Filter, FilterParser } from "ldapts";
import { USERNAME_PLACEHOLDER } from "./defaults";

export { USERNAME_PLACEHOLDER };
export const DN_PLACEHOLDER = "{dn}";

/** RFC 4515: `*`, `(`, `)`, `\` and NUL become `\2a`-style escapes. */
export function escapeFilterValue(value: string): string {
  return Filter.escape(value);
}

/**
 * RFC 4514 for an attribute value inside a DN. ldapts' own DN class quotes instead, which RFC 4514
 * dropped and not every server still parses.
 */
export function escapeDnValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const edge = i === 0 || i === value.length - 1;
    if (ch === "\u0000") {
      out += "\\00";
    } else if (',+"\\<>;='.includes(ch)) {
      out += `\\${ch}`;
    } else if (ch === " " && edge) {
      out += "\\ ";
    } else if (ch === "#" && i === 0) {
      out += "\\#";
    } else {
      out += ch;
    }
  }
  return out;
}

function replaceAll(template: string, placeholder: string, value: string): string {
  return template.split(placeholder).join(value);
}

/** The operator's filter with every `{username}` replaced by the escaped name. */
export function buildUserFilter(template: string, username: string): string {
  return replaceAll(template, USERNAME_PLACEHOLDER, escapeFilterValue(username));
}

/** A group search filter naming the user's DN, escaped as a filter value. */
export function buildGroupFilter(template: string, userDn: string): string {
  return replaceAll(template, DN_PLACEHOLDER, escapeFilterValue(userDn));
}

/** A bind DN from a template such as `uid={username},ou=people,dc=example,dc=org`. */
export function buildUserDn(template: string, username: string): string {
  return replaceAll(template, USERNAME_PLACEHOLDER, escapeDnValue(username));
}

/** Whether a filter template, filled with a harmless value, parses as LDAP filter syntax. */
export function isValidFilterTemplate(template: string, placeholder: string): boolean {
  if (!template.includes(placeholder)) return false;
  try {
    FilterParser.parseString(replaceAll(template, placeholder, "x"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The value of a DN's first RDN, unescaped: `CN=Proxy Admins,OU=Groups,...` is "Proxy Admins".
 * Groups map by name, and a DN would never survive the comma-separated group fields.
 */
export function firstRdnValue(dn: string): string | null {
  let i = dn.indexOf("=");
  if (i < 0) return null;
  let value = "";
  for (i += 1; i < dn.length; i++) {
    const ch = dn[i];
    if (ch === "\\" && i + 1 < dn.length) {
      const hex = dn.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        // Hex pairs are UTF-8 bytes; a run of them decodes together below.
        value += `%${hex}`;
        i += 2;
      } else {
        value += encodeURIComponent(dn[i + 1]);
        i += 1;
      }
      continue;
    }
    if (ch === "," || ch === "+" || ch === ";") break;
    value += encodeURIComponent(ch);
  }
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}
