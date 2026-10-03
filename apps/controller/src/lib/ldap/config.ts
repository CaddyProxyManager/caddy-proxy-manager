/**
 * A directory's settings beyond the columns it borrows from `oauth_providers` (URL in `issuer`,
 * bind DN in `clientId`, bind password in `clientSecret`). Stored as JSON in `ldapConfig`.
 */
import { X509Certificate } from "node:crypto";
import { domainError } from "../domain-error";
import { parseBindNameTemplate } from "./bind-name";
import { DN_PLACEHOLDER, USERNAME_PLACEHOLDER, isValidFilterTemplate } from "./escape";
import {
  DEFAULT_LDAP_CONFIG,
  LDAP_GROUP_SOURCES,
  type LdapConfig,
  type LdapGroupSource,
} from "./defaults";

export { LDAP_PROVIDER_TYPE, type LdapConfig } from "./defaults";

const ATTRIBUTE_NAME = /^(?:[A-Za-z][A-Za-z0-9-]{0,63}|\d+(?:\.\d+)+)$/;
const MAX_TEXT = 1024;
const MAX_PEM = 64 * 1024;

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Tolerant: a stored row from an older shape still reads, with defaults for what it lacks. */
export function parseLdapConfig(raw: string | null | undefined): LdapConfig {
  let value: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
    } catch {
      // An unreadable row fails validation at sign-in rather than here.
    }
  }
  return normalizeLdapConfig(value);
}

export function normalizeLdapConfig(value: Record<string, unknown>): LdapConfig {
  const d = DEFAULT_LDAP_CONFIG;
  const groupSource = LDAP_GROUP_SOURCES.includes(value.groupSource as LdapGroupSource)
    ? (value.groupSource as LdapGroupSource)
    : d.groupSource;
  return {
    baseDn: text(value.baseDn, d.baseDn),
    userFilter: text(value.userFilter, d.userFilter) || d.userFilter,
    userDnTemplate: optionalText(value.userDnTemplate),
    startTls: value.startTls === true,
    // Only an explicit false turns verification off.
    tlsVerify: value.tlsVerify !== false,
    caPem: optionalText(value.caPem),
    emailAttribute: text(value.emailAttribute, d.emailAttribute) || d.emailAttribute,
    nameAttribute: text(value.nameAttribute, d.nameAttribute) || d.nameAttribute,
    groupSource,
    groupBaseDn: optionalText(value.groupBaseDn),
    groupFilter: text(value.groupFilter, d.groupFilter) || d.groupFilter,
    groupNameAttribute:
      text(value.groupNameAttribute, d.groupNameAttribute) || d.groupNameAttribute,
  };
}

export type ParsedLdapUrl = { secure: boolean; host: string; port: number; url: string };

/** ldap:// or ldaps:// with a host and nothing else; anything more is not a server address. */
export function parseLdapUrl(raw: string | null | undefined): ParsedLdapUrl | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "ldaps:";
  if (!secure && url.protocol !== "ldap:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
  const port = url.port ? Number(url.port) : secure ? 636 : 389;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Rebuilt, so what is stored and dialled is exactly scheme, host and port.
  return { secure, host: url.hostname, port, url: `${url.protocol}//${url.host}` };
}

function isValidCaPem(pem: string): boolean {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length === 0) return false;
  try {
    for (const block of blocks) new X509Certificate(block);
    return true;
  } catch {
    return false;
  }
}

/** Throws a DomainError for the first thing wrong; the editor and the model both call it. */
export function validateLdapSettings(input: { url: string; config: LdapConfig }): void {
  const { url, config } = input;
  const parsed = parseLdapUrl(url);
  if (!parsed) throw domainError("ldapUrlInvalid", {}, { status: 400 });
  if (parsed.secure && config.startTls) {
    throw domainError("ldapStartTlsWithLdaps", {}, { status: 400 });
  }
  if (!config.baseDn || config.baseDn.length > MAX_TEXT) {
    throw domainError("ldapBaseDnRequired", {}, { status: 400 });
  }
  if (
    config.userFilter.length > MAX_TEXT ||
    !isValidFilterTemplate(config.userFilter, USERNAME_PLACEHOLDER)
  ) {
    throw domainError(
      "ldapUserFilterInvalid",
      { placeholder: USERNAME_PLACEHOLDER },
      { status: 400 },
    );
  }
  if (config.userDnTemplate !== null) {
    const bindName =
      config.userDnTemplate.length > MAX_TEXT ? null : parseBindNameTemplate(config.userDnTemplate);
    if (!bindName) {
      throw domainError(
        "ldapDnTemplateInvalid",
        { placeholder: USERNAME_PLACEHOLDER },
        { status: 400 },
      );
    }
    // Every sign-in sends the user's own password in the bind. The DN form predates this rule and
    // keeps working as saved.
    if (bindName.kind !== "dn" && !parsed.secure && !config.startTls) {
      throw domainError("ldapUserBindNeedsTls", {}, { status: 400 });
    }
  }
  if (
    config.groupSource === "search" &&
    (config.groupFilter.length > MAX_TEXT ||
      !isValidFilterTemplate(config.groupFilter, DN_PLACEHOLDER))
  ) {
    throw domainError("ldapGroupFilterInvalid", { placeholder: DN_PLACEHOLDER }, { status: 400 });
  }
  if ((config.groupBaseDn?.length ?? 0) > MAX_TEXT) {
    throw domainError("ldapBaseDnRequired", {}, { status: 400 });
  }
  for (const attribute of [
    config.emailAttribute,
    config.nameAttribute,
    config.groupNameAttribute,
  ]) {
    if (!ATTRIBUTE_NAME.test(attribute)) {
      throw domainError("ldapAttributeInvalid", { attribute }, { status: 400 });
    }
  }
  if (config.caPem !== null && (config.caPem.length > MAX_PEM || !isValidCaPem(config.caPem))) {
    throw domainError("ldapCaPemInvalid", {}, { status: 400 });
  }
}
