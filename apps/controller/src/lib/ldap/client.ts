/**
 * Talks to a directory. Every way a sign-in can fail comes back as one of a few reasons, which the
 * caller collapses into "invalid username or password"; the detail goes to the server log only.
 */
import { domainError } from "../domain-error";
import { isIP } from "node:net";
import { type ConnectionOptions, rootCertificates } from "node:tls";
import {
  Client,
  type Entry,
  InvalidCredentialsError,
  ResultCodeError,
  SizeLimitExceededError,
} from "ldapts";
import type { LdapDirectory } from "../models/ldap-directories";
import {
  buildBindName,
  isAcceptableBindNameUsername,
  isBoundPrincipal,
  parseBindNameTemplate,
} from "./bind-name";
import { parseLdapUrl } from "./config";
import { buildGroupFilter, buildUserDn, buildUserFilter, firstRdnValue } from "./escape";

const CONNECT_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10_000;
/** Enough for anyone's group list; a larger answer is a filter matching far too much. */
const GROUP_LIMIT = 1_000;
export const LDAP_USERNAME_MAX_LENGTH = 256;
export const LDAP_PASSWORD_MAX_LENGTH = 1_024;

export type LdapIdentity = {
  dn: string;
  /** objectGUID, entryUUID or, failing both, the DN: what `accounts.accountId` holds. */
  accountId: string;
  email: string | null;
  name: string | null;
  groups: string[];
};

export type LdapFailure =
  | "invalid-input"
  | "invalid-credentials"
  | "not-found"
  | "ambiguous"
  /** Outside the characters a UPN or down-level bind name may carry. */
  | "refused-username"
  /** The user filter found an entry other than the account that bound. */
  | "other-entry"
  | "unavailable";

export type LdapAuthResult =
  | { ok: true; identity: LdapIdentity }
  | { ok: false; reason: LdapFailure };

/** Control characters have no business in a sign-in name, escaped or not. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isAcceptableLdapUsername(username: string): boolean {
  return (
    username.length > 0 &&
    username.length <= LDAP_USERNAME_MAX_LENGTH &&
    !hasControlCharacter(username)
  );
}

/**
 * Checked before any bind: an empty password is an unauthenticated bind (RFC 4513 5.1.2), which
 * some servers, Active Directory among them, answer with success.
 */
export function isAcceptableLdapPassword(password: string): boolean {
  return password.length > 0 && password.length <= LDAP_PASSWORD_MAX_LENGTH;
}

export function ldapTlsOptions(directory: LdapDirectory): ConnectionOptions {
  const parsed = parseLdapUrl(directory.url);
  const host = parsed?.host ?? "";
  const { caPem, tlsVerify } = directory.config;
  return {
    // `ca` replaces the system roots rather than adding to them.
    ...(caPem ? { ca: [...rootCertificates, caPem] } : {}),
    rejectUnauthorized: tlsVerify,
    ...(host && !isIP(host) ? { servername: host } : {}),
    minVersion: "TLSv1.2",
  };
}

/** Connected, and upgraded when StartTLS is on: a failed upgrade throws, never falls back. */
async function openClient(directory: LdapDirectory): Promise<Client> {
  const parsed = parseLdapUrl(directory.url);
  if (!parsed) throw domainError("ldapUrlInvalid");
  const tlsOptions = ldapTlsOptions(directory);
  const client = new Client({
    url: parsed.url,
    connectTimeout: CONNECT_TIMEOUT_MS,
    timeout: OPERATION_TIMEOUT_MS,
    // Only for ldaps://; StartTLS takes its options in startTLS(), and the constructor's would be
    // applied to the plain connection too.
    ...(parsed.secure ? { tlsOptions } : {}),
  });
  if (directory.config.startTls && !parsed.secure) {
    try {
      await client.startTLS(tlsOptions);
    } catch (error) {
      await close(client);
      throw error;
    }
  }
  return client;
}

async function close(client: Client | null): Promise<void> {
  if (!client) return;
  try {
    await client.unbind();
  } catch {
    // Already gone.
  }
}

/** Attribute names come back as the server spells them. */
function attribute(entry: Entry, name: string): Entry[string] | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(entry)) {
    if (key.toLowerCase() === wanted) return entry[key];
  }
  return undefined;
}

function firstString(value: Entry[string] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return null;
  const text = (Buffer.isBuffer(first) ? first.toString("utf8") : String(first)).trim();
  return text || null;
}

function strings(value: Entry[string] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => (Buffer.isBuffer(item) ? item.toString("utf8") : String(item)).trim())
    .filter(Boolean);
}

/** AD's byte order: the first three fields are little-endian. */
export function formatObjectGuid(bytes: Buffer): string | null {
  if (bytes.length !== 16) return null;
  const hex = (start: number, end: number, reverse: boolean) => {
    const slice = [...bytes.subarray(start, end)];
    if (reverse) slice.reverse();
    return slice.map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  return [
    hex(0, 4, true),
    hex(4, 6, true),
    hex(6, 8, true),
    hex(8, 10, false),
    hex(10, 16, false),
  ].join("-");
}

/** Stable across renames and moves where the directory offers it, which a DN is not. */
export function stableAccountId(entry: Entry): string {
  const guid = attribute(entry, "objectGUID");
  const guidBytes = Array.isArray(guid) ? guid[0] : guid;
  if (Buffer.isBuffer(guidBytes)) {
    const formatted = formatObjectGuid(guidBytes);
    if (formatted) return formatted;
  }
  const uuid = firstString(attribute(entry, "entryUUID"));
  if (uuid) return uuid.toLowerCase();
  return entry.dn.toLowerCase();
}

function userAttributes(directory: LdapDirectory): string[] {
  const { emailAttribute, nameAttribute, groupSource } = directory.config;
  const wanted = [emailAttribute, nameAttribute, "cn", "objectGUID", "entryUUID"];
  if (groupSource === "memberOf") wanted.push("memberOf");
  return [...new Set(wanted)];
}

/** What proves a UPN or down-level bind and the entry found are the same account. */
const BOUND_NAME_ATTRIBUTES = ["userPrincipalName", "sAMAccountName"];
const WHO_AM_I_OID = "1.3.6.1.4.1.4203.1.11.3";

/** RFC 4532, which AD answers with `u:DOMAIN\name`; null where the server does not support it. */
async function whoAmI(client: Client): Promise<string | null> {
  try {
    const { value } = await client.exop(WHO_AM_I_OID);
    return value?.trim() || null;
  } catch (error) {
    if (error instanceof ResultCodeError) return null;
    throw error;
  }
}

async function findUser(
  client: Client,
  directory: LdapDirectory,
  username: string,
  extraAttributes: string[] = [],
): Promise<{ entry: Entry | null; ambiguous: boolean }> {
  try {
    const { searchEntries } = await client.search(directory.config.baseDn, {
      scope: "sub",
      filter: buildUserFilter(directory.config.userFilter, username),
      attributes: [...userAttributes(directory), ...extraAttributes],
      explicitBufferAttributes: ["objectGUID"],
      // Two is enough to tell "one" from "more than one".
      sizeLimit: 2,
    });
    if (searchEntries.length > 1) return { entry: null, ambiguous: true };
    return { entry: searchEntries[0] ?? null, ambiguous: false };
  } catch (error) {
    if (error instanceof SizeLimitExceededError) return { entry: null, ambiguous: true };
    throw error;
  }
}

async function readOwnEntry(client: Client, directory: LdapDirectory, dn: string) {
  const { searchEntries } = await client.search(dn, {
    scope: "base",
    filter: "(objectClass=*)",
    attributes: userAttributes(directory),
    explicitBufferAttributes: ["objectGUID"],
  });
  return searchEntries[0] ?? null;
}

async function readGroups(
  client: Client,
  directory: LdapDirectory,
  entry: Entry,
): Promise<string[]> {
  const { groupSource, groupFilter, groupBaseDn, baseDn, groupNameAttribute } = directory.config;
  let names: string[] = [];
  if (groupSource === "memberOf") {
    names = strings(attribute(entry, "memberOf"))
      .map(firstRdnValue)
      .filter((name): name is string => !!name);
  } else if (groupSource === "search") {
    const { searchEntries } = await client.search(groupBaseDn || baseDn, {
      scope: "sub",
      filter: buildGroupFilter(groupFilter, entry.dn),
      attributes: [groupNameAttribute],
      sizeLimit: GROUP_LIMIT,
    });
    names = searchEntries
      .map((group) => firstString(attribute(group, groupNameAttribute)) ?? firstRdnValue(group.dn))
      .filter((name): name is string => !!name);
  }
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toIdentity(directory: LdapDirectory, entry: Entry, groups: string[]): LdapIdentity {
  const { emailAttribute, nameAttribute } = directory.config;
  return {
    dn: entry.dn,
    accountId: stableAccountId(entry),
    email: firstString(attribute(entry, emailAttribute)),
    name: firstString(attribute(entry, nameAttribute)) ?? firstString(attribute(entry, "cn")),
    groups,
  };
}

function logFailure(directory: LdapDirectory, stage: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.warn(`[ldap] ${directory.name}: ${stage} failed - ${detail}`);
}

/** Checks a username and password against one directory. Never throws. */
export async function authenticateLdap(
  directory: LdapDirectory,
  username: string,
  password: string,
): Promise<LdapAuthResult> {
  if (!isAcceptableLdapUsername(username) || !isAcceptableLdapPassword(password)) {
    return { ok: false, reason: "invalid-input" };
  }

  let service: Client | null = null;
  let user: Client | null = null;
  let stage = "connecting";
  try {
    const template = directory.config.userDnTemplate;
    const bindName = template ? parseBindNameTemplate(template) : null;
    if (template && !bindName) {
      logFailure(directory, "reading the settings", new Error("the user bind name is invalid"));
      return { ok: false, reason: "unavailable" };
    }
    if (bindName && bindName.kind !== "dn") {
      if (!isAcceptableBindNameUsername(username)) return { ok: false, reason: "refused-username" };
      stage = "the user bind";
      user = await openClient(directory);
      await user.bind(buildBindName(bindName, username), password);
      // The user's own rights from here on: AD lets any user read entries and memberships.
      stage = "the user search";
      const found = await findUser(user, directory, username, BOUND_NAME_ATTRIBUTES);
      if (found.ambiguous) {
        console.warn(`[ldap] ${directory.name}: the user filter matched more than one entry`);
        return { ok: false, reason: "ambiguous" };
      }
      if (!found.entry) return { ok: false, reason: "not-found" };
      stage = "the principal check";
      const names = {
        dn: found.entry.dn,
        userPrincipalName: firstString(attribute(found.entry, "userPrincipalName")),
        sAMAccountName: firstString(attribute(found.entry, "sAMAccountName")),
        authzId: await whoAmI(user),
      };
      if (!isBoundPrincipal(bindName, username, names)) {
        console.warn(
          `[ldap] ${directory.name}: the user filter found ${found.entry.dn}, not the account that bound`,
        );
        return { ok: false, reason: "other-entry" };
      }
      stage = "the group lookup";
      const groups = await readGroups(user, directory, found.entry);
      return { ok: true, identity: toIdentity(directory, found.entry, groups) };
    }
    if (bindName) {
      // No service account: the user's own bind is the only one, and it reads its own entry.
      stage = "the user bind";
      user = await openClient(directory);
      const dn = buildUserDn(bindName.template, username);
      await user.bind(dn, password);
      stage = "reading the user's entry";
      const entry = await readOwnEntry(user, directory, dn);
      if (!entry) return { ok: false, reason: "not-found" };
      stage = "the group lookup";
      return {
        ok: true,
        identity: toIdentity(directory, entry, await readGroups(user, directory, entry)),
      };
    }

    service = await openClient(directory);
    if (directory.bindDn) {
      stage = "the service bind";
      await service.bind(directory.bindDn, directory.bindPassword);
    }
    stage = "the user search";
    const found = await findUser(service, directory, username);
    if (found.ambiguous) {
      console.warn(`[ldap] ${directory.name}: the user filter matched more than one entry`);
      return { ok: false, reason: "ambiguous" };
    }
    if (!found.entry) return { ok: false, reason: "not-found" };

    // Its own connection, so the service connection keeps the service account's rights for groups.
    stage = "the user bind";
    user = await openClient(directory);
    await user.bind(found.entry.dn, password);
    stage = "the group lookup";
    const groups = await readGroups(service, directory, found.entry);
    return { ok: true, identity: toIdentity(directory, found.entry, groups) };
  } catch (error) {
    if (error instanceof InvalidCredentialsError && stage === "the user bind") {
      return { ok: false, reason: "invalid-credentials" };
    }
    logFailure(directory, stage, error);
    return { ok: false, reason: "unavailable" };
  } finally {
    await Promise.all([close(service), close(user)]);
  }
}

export type LdapTestResult =
  | { ok: true; identity: LdapIdentity | null }
  | {
      ok: false;
      stage: "connect" | "bind" | "search" | "sign-in";
      reason?: LdapFailure;
      /** The server's or the TLS layer's own words, for the administrator testing. */
      detail?: string;
    };

/**
 * For Settings: connect, upgrade, service bind and read the base DN, then optionally sign in as
 * a test user. Reports the stage that failed, which a real sign-in never does.
 */
export async function testLdapConnection(
  directory: LdapDirectory,
  probe?: { username: string; password: string },
): Promise<LdapTestResult> {
  let client: Client | null = null;
  const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try {
    try {
      // A refused StartTLS lands here whatever its type: it must never read as reachable.
      client = await openClient(directory);
    } catch (error) {
      return { ok: false, stage: "connect", detail: detail(error) };
    }
    try {
      // The root DSE, anonymously: it opens the socket, and any LDAP answer proves it is up.
      await client.search("", { scope: "base", filter: "(objectClass=*)", attributes: ["1.1"] });
    } catch (error) {
      if (!(error instanceof ResultCodeError)) {
        return { ok: false, stage: "connect", detail: detail(error) };
      }
    }
    // A template binds as each user, so only a test sign-in can go further.
    if (!directory.config.userDnTemplate) {
      if (directory.bindDn) {
        try {
          await client.bind(directory.bindDn, directory.bindPassword);
        } catch (error) {
          return { ok: false, stage: "bind", detail: detail(error) };
        }
      }
      try {
        await client.search(directory.config.baseDn, { scope: "base", attributes: ["1.1"] });
      } catch (error) {
        return { ok: false, stage: "search", detail: detail(error) };
      }
    }
  } finally {
    await close(client);
  }

  if (!probe) return { ok: true, identity: null };
  const result = await authenticateLdap(directory, probe.username, probe.password);
  return result.ok
    ? { ok: true, identity: result.identity }
    : { ok: false, stage: "sign-in", reason: result.reason };
}
