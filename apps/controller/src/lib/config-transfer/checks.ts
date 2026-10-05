/**
 * What a save would check, run on each imported row: a file carries stored columns, which skip
 * every model's own validation. A check returns the row as the save would store it, or throws the
 * save's DomainError, which the plan turns into a skip.
 */
import {
  ACCESS_LIST_SATISFY,
  IP_RULE_ACTIONS,
  sanitizeDenyResponse,
  sanitizeIpRules,
} from "../access-lists/rules";
import { isBlockedSourceKind } from "../blocked-sources/types";
import { domainError } from "../errors/domain-error";
import { assertImportedL4ProxyHostValid } from "../models/l4-proxy-hosts";
import { normalizeBlockedValue } from "../models/blocked-sources";
import { normalizeImportedProxyHost } from "../models/proxy-hosts";
import type { WafSettings } from "../settings";
import {
  ExclusionInputError,
  checkStoredExclusionPath,
  normalizeExclusionReason,
  normalizeExclusionTarget,
  validateExclusionRuleId,
} from "../waf/exclusions";
import type { Row } from "./spec";

export type CheckContext = { globalWaf: WafSettings | null };
type RowCheck = (row: Row, context: CheckContext) => Row;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Exclusion helpers throw their own error type; the plan reads DomainErrors. */
function exclusionChecked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ExclusionInputError) throw domainError(error.code, {}, { status: 400 });
    throw error;
  }
}

export const IMPORT_CHECKS: Readonly<Record<string, RowCheck>> = {
  proxy_hosts: (row, { globalWaf }) => ({
    ...row,
    ...normalizeImportedProxyHost(
      { domains: row.domains, upstreams: row.upstreams, meta: row.meta },
      globalWaf,
    ),
  }),
  l4_proxy_hosts: (row) => {
    assertImportedL4ProxyHostValid(row);
    return row;
  },
  access_lists: (row) => {
    if (!(IP_RULE_ACTIONS as readonly unknown[]).includes(row.ipDefault ?? "deny")) {
      throw domainError("accessListIpDefaultInvalid", {}, { status: 400 });
    }
    if (!(ACCESS_LIST_SATISFY as readonly unknown[]).includes(row.satisfy ?? "all")) {
      throw domainError("accessListSatisfyInvalid", {}, { status: 400 });
    }
    // As the model reads the three columns back, then as it writes them.
    const deny = sanitizeDenyResponse(
      row.denyRedirectUrl
        ? { redirectUrl: row.denyRedirectUrl }
        : row.denyStatus == null && !row.denyBody
          ? null
          : { status: row.denyStatus ?? 403, body: text(row.denyBody) },
    );
    return {
      ...row,
      denyStatus: deny && !deny.redirectUrl ? deny.status : null,
      denyBody: deny?.body ?? null,
      denyRedirectUrl: deny?.redirectUrl ?? null,
    };
  },
  access_list_ip_rules: (row) => {
    const [rule] = sanitizeIpRules([row]);
    return {
      ...row,
      action: rule.action,
      cidr: rule.cidr,
      hostname: rule.hostname,
      country: rule.country ?? null,
      continent: rule.continent ?? null,
      asn: rule.asn ?? null,
      note: rule.note,
      expiresAt: rule.expiresAt ?? null,
    };
  },
  blocked_sources: (row) => {
    if (!isBlockedSourceKind(row.kind)) {
      throw domainError("blockedSourceKindInvalid", {}, { status: 400 });
    }
    return { ...row, value: normalizeBlockedValue(row.kind, text(row.value)) };
  },
  waf_exclusions: (row) =>
    exclusionChecked(() => ({
      ...row,
      ruleId: validateExclusionRuleId(row.ruleId),
      path: checkStoredExclusionPath(row.path == null ? null : text(row.path)),
      target: normalizeExclusionTarget(row.target ?? null),
      reason: normalizeExclusionReason(row.reason),
    })),
};
