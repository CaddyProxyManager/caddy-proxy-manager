/**
 * "Bind as the user": what the template names the bind with. A DN, or for Active Directory a UPN
 * (`{username}@ad.example.org`) or a down-level logon name (`EXAMPLE\{username}`). Pure and
 * dependency-free, so the editor classifies a template the way sign-in does.
 */
import { USERNAME_PLACEHOLDER } from "./defaults";

export type BindNameTemplate =
  | { kind: "dn"; template: string }
  | { kind: "upn"; realm: string }
  | { kind: "down-level"; domain: string };

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const UPN_TEMPLATE = new RegExp(`^\\{username\\}@(${LABEL}(?:\\.${LABEL})*)$`);
// A NetBIOS domain name: at most 15 characters, and none of the ones that would need quoting.
const DOWN_LEVEL_TEMPLATE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,14})\\\{username\}$/;

/** Null for a template that is none of the three. */
export function parseBindNameTemplate(template: string): BindNameTemplate | null {
  const upn = UPN_TEMPLATE.exec(template);
  if (upn) return { kind: "upn", realm: upn[1] };
  const downLevel = DOWN_LEVEL_TEMPLATE.exec(template);
  if (downLevel) return { kind: "down-level", domain: downLevel[1] };
  if (template.includes("=") && template.includes(USERNAME_PLACEHOLDER)) {
    return { kind: "dn", template };
  }
  return null;
}

/**
 * A UPN or down-level name has no escaping (RFC 4514 is for DNs), so anything that could change
 * which principal is named is refused rather than escaped. sAMAccountName already forbids
 * `"/\[]:;|=,+*?<>`; `@`, spaces and a leading or trailing dot are refused on top.
 */
const BIND_NAME_USERNAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;

export function isAcceptableBindNameUsername(username: string): boolean {
  return BIND_NAME_USERNAME.test(username);
}

/** Only for a username that passed isAcceptableBindNameUsername. */
export function buildBindName(
  template: Exclude<BindNameTemplate, { kind: "dn" }>,
  username: string,
): string {
  return template.kind === "upn"
    ? `${username}@${template.realm}`
    : `${template.domain}\\${username}`;
}

export type BoundEntryNames = {
  dn: string;
  userPrincipalName: string | null;
  sAMAccountName: string | null;
  /** The server's RFC 4532 "Who am I?" answer, when it gave one. */
  authzId: string | null;
};

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Whether the entry the user filter found is the principal that bound, so a filter matching the
 * wrong entry cannot sign someone in as another person. A UPN must be the entry's own
 * userPrincipalName: AD also binds `sAMAccountName@domain` for an entry without one, but so could
 * a different entry whose UPN happens to read the same.
 */
export function isBoundPrincipal(
  template: Exclude<BindNameTemplate, { kind: "dn" }>,
  username: string,
  entry: BoundEntryNames,
): boolean {
  if (template.kind === "upn") {
    if (!same(entry.userPrincipalName, buildBindName(template, username))) return false;
  } else if (!same(entry.sAMAccountName, username)) {
    return false;
  }
  return authzIdMatches(template, entry);
}

/** AD answers `u:DOMAIN\sAMAccountName`; an answer in another shape is checked as far as it can be. */
function authzIdMatches(
  template: Exclude<BindNameTemplate, { kind: "dn" }>,
  entry: BoundEntryNames,
): boolean {
  const id = entry.authzId;
  if (!id) return true;
  if (id.toLowerCase().startsWith("dn:")) return same(entry.dn, id.slice(3));
  if (!id.toLowerCase().startsWith("u:")) return false;
  const name = id.slice(2);
  const slash = name.indexOf("\\");
  if (slash < 0) return true;
  const domain = name.slice(0, slash);
  const account = name.slice(slash + 1);
  if (template.kind === "down-level" && !same(domain, template.domain)) return false;
  return same(entry.sAMAccountName, account);
}
