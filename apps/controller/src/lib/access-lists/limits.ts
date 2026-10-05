/** Client safe: the access-list editor and the model share these. */

export const ACCESS_RULE_KINDS = ["address", "country", "continent", "asn"] as const;
/** `address` is an IP, a CIDR range or a hostname; the server tells them apart. */
export type AccessRuleKind = (typeof ACCESS_RULE_KINDS)[number];

export const DENY_STATUS_MIN = 400;
export const DENY_STATUS_MAX = 599;
export const DEFAULT_DENY_STATUS = 403;
export const DEFAULT_DENY_BODY = "Access denied";
export const MAX_DENY_BODY_LENGTH = 8192;
export const MAX_DENY_REDIRECT_LENGTH = 2048;
