/**
 * An access list as Caddy handlers. Pure, so the decision table is testable without a database.
 * An allowed address "passes" because a subroute route with no handlers carries on with the host.
 * Address rules use Caddy's own `client_ip`; a list with a country, continent or ASN rule is
 * decided by the blocker module instead, since only it can look those up.
 */
import { isIP } from "node:net";
import { ipVersion } from "../http/ip-version";
import { CONTINENT_CODES } from "../blocked-sources/types";
import { domainError } from "../errors/domain-error";
import { tagOutcome } from "../caddy/outcome-markers";
import {
  DEFAULT_DENY_BODY,
  DEFAULT_DENY_STATUS,
  DENY_STATUS_MAX,
  DENY_STATUS_MIN,
  MAX_DENY_BODY_LENGTH,
  MAX_DENY_REDIRECT_LENGTH,
} from "./limits";

export const IP_RULE_ACTIONS = ["allow", "deny"] as const;
export type IpRuleAction = (typeof IP_RULE_ACTIONS)[number];
export const ACCESS_LIST_SATISFY = ["all", "any"] as const;
export type AccessListSatisfy = (typeof ACCESS_LIST_SATISFY)[number];

/** Exactly one target: `cidr`, `hostname`, `country`, `continent` or `asn`. */
export type IpRule = {
  action: IpRuleAction;
  cidr: string | null;
  hostname: string | null;
  country?: string | null;
  continent?: string | null;
  asn?: number | null;
  note: string | null;
  /** ISO time; past it the rule is ignored, then pruned. */
  expiresAt?: string | null;
};

/** A rule as Caddy sees it. A hostname that has not resolved has no ranges. */
export type RuntimeIpRule = {
  action: IpRuleAction;
  ranges: readonly string[];
  countries?: readonly string[];
  continents?: readonly string[];
  asns?: readonly number[];
};

/** What a denied request gets. A redirect wins over the status and body. */
export type DenyResponse = { status: number; body: string | null; redirectUrl: string | null };

export type AccessListRuntime = {
  accounts: { username: string; passwordHash: string }[];
  ipRules: RuntimeIpRule[];
  ipDefault: IpRuleAction;
  satisfy: AccessListSatisfy;
  passAuth: boolean;
  /** Unset is a plain 403. */
  deny?: DenyResponse;
  /** Refuse a request whose client cannot be told apart from a trusted proxy. Needs the blocker. */
  failClosed?: boolean;
  /** Where the blocker finds the client behind a proxy; Caddy's own matchers use the server's. */
  trustedProxies?: readonly string[];
  /** Whether the blocker module is in Caddy. Without it only `failClosed` is lost here. */
  blockerUsable?: boolean;
};

/** Caps what one list can put in every request's path. A hostname is one rule. */
export const MAX_IP_RULES = 500;
const MAX_NOTE_LENGTH = 200;

/** Per name, so a hostname rule adds at most this many ranges to every request's path. */
export const MAX_ADDRESSES_PER_HOSTNAME = 16;
/** A home connection's AAAA changes within its /64 as privacy addresses rotate. */
export const DEFAULT_HOSTNAME_IPV6_PREFIX = 64;
/** Wider than a site's usual allocation would admit strangers. */
const MIN_HOSTNAME_IPV6_PREFIX = 48;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A bare address becomes a single-address range; anything else must be a well-formed CIDR. */
export function normalizeCidr(value: string): string | null {
  const text = value.trim();
  const slash = text.indexOf("/");
  if (slash === -1) {
    const version = ipVersion(text);
    return version === 4 ? `${text}/32` : version === 6 ? `${text}/128` : null;
  }
  const address = text.slice(0, slash);
  const prefix = text.slice(slash + 1);
  const version = ipVersion(address);
  if (version === 0 || !/^\d{1,3}$/.test(prefix)) return null;
  return Number(prefix) <= (version === 4 ? 32 : 128) ? `${address}/${Number(prefix)}` : null;
}

/**
 * `name` or `name/N`, N being the IPv6 prefix its AAAA answers widen to; IPv4 answers are always
 * a /32. Lowercased, without a trailing dot.
 */
export function normalizeRuleHostname(value: string): string | null {
  const text = value.trim().toLowerCase();
  const slash = text.indexOf("/");
  const name = (slash === -1 ? text : text.slice(0, slash)).replace(/\.$/, "");
  // An all-digit last label is an IPv4 address gone wrong, not a name.
  if (!HOSTNAME.test(name) || /^\d+$/.test(name.slice(name.lastIndexOf(".") + 1))) return null;
  if (slash === -1) return name;
  const prefix = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  return bits >= MIN_HOSTNAME_IPV6_PREFIX && bits <= 128 ? `${name}/${bits}` : null;
}

/** The name to look up, and the prefix its IPv6 answers widen to. */
export function splitRuleHostname(value: string): { name: string; ipv6Prefix: number } {
  const slash = value.indexOf("/");
  if (slash === -1) return { name: value, ipv6Prefix: DEFAULT_HOSTNAME_IPV6_PREFIX };
  return { name: value.slice(0, slash), ipv6Prefix: Number(value.slice(slash + 1)) };
}

function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) =>
    part ? part.split(":").map((hex) => Number.parseInt(hex, 16)) : [];
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? all
    : null;
}

/** The network an IPv6 address sits in, canonically written (the URL parser compresses it). */
function ipv6Network(address: string, bits: number): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const masked = groups.map((group, index) => {
    const keep = Math.min(Math.max(bits - index * 16, 0), 16);
    return group & ((0xffff << (16 - keep)) & 0xffff);
  });
  const host = new URL(`http://[${masked.map((g) => g.toString(16)).join(":")}]/`).hostname;
  return `${host.slice(1, -1)}/${bits}`;
}

/**
 * The ranges a resolved name stands for. Unspecified addresses are dropped (a filtering resolver
 * answers blocked names with them), and so are IPv4-mapped AAAA answers, which the A lookup covers.
 */
export function hostnameRanges(addresses: readonly string[], ipv6Prefix: number): string[] {
  const ranges = new Set<string>();
  for (const address of addresses) {
    const version = isIP(address);
    if (version === 4 && address !== "0.0.0.0") ranges.add(`${address}/32`);
    if (version === 6 && !address.includes(".") && ipv6Groups(address)?.some((g) => g !== 0)) {
      const network = ipv6Network(address, ipv6Prefix);
      if (network) ranges.add(network);
    }
  }
  return [...ranges].slice(0, MAX_ADDRESSES_PER_HOSTNAME);
}

/** A country, continent or ASN rule: only the blocker module can decide it. */
export function isGeoRule(rule: Pick<IpRule, "country" | "continent" | "asn">): boolean {
  return Boolean(rule.country || rule.continent || rule.asn);
}

/** Whether a rule is in force at `now`. */
export function isRuleActive(rule: Pick<IpRule, "expiresAt">, now = Date.now()): boolean {
  return !rule.expiresAt || Date.parse(rule.expiresAt) > now;
}

/**
 * Hostnames become their ranges in place, so the first matching rule still decides. Without the
 * blocker a geo rule is left with no target, which is how an unresolved name is skipped too.
 */
export function expandIpRules(
  rules: readonly Pick<IpRule, "action" | "cidr" | "hostname" | "country" | "continent" | "asn">[],
  lookup: (name: string) => readonly string[] | undefined,
  options: { geoUsable?: boolean } = {},
): RuntimeIpRule[] {
  const geoUsable = options.geoUsable ?? true;
  return rules.map((rule) => {
    if (rule.cidr) return { action: rule.action, ranges: [rule.cidr] };
    if (isGeoRule(rule)) {
      if (!geoUsable) return { action: rule.action, ranges: [] };
      return {
        action: rule.action,
        ranges: [],
        ...(rule.country ? { countries: [rule.country] } : {}),
        ...(rule.continent ? { continents: [rule.continent] } : {}),
        ...(rule.asn ? { asns: [rule.asn] } : {}),
      };
    }
    if (!rule.hostname) return { action: rule.action, ranges: [] };
    const { name, ipv6Prefix } = splitRuleHostname(rule.hostname);
    return { action: rule.action, ranges: hostnameRanges(lookup(name) ?? [], ipv6Prefix) };
  });
}

const textOf = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

function normalizeCountry(value: string): string | null {
  const code = value.toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : null;
}

function normalizeContinent(value: string): string | null {
  const code = value.toUpperCase();
  return (CONTINENT_CODES as readonly string[]).includes(code) ? code : null;
}

/** `AS13335` or `13335`. */
export function normalizeAsn(value: string): number | null {
  const digits = value.replace(/^as/i, "");
  const asn = Number(digits);
  return /^\d{1,10}$/.test(digits) && asn > 0 && asn <= 4_294_967_295 ? asn : null;
}

function normalizeRuleExpiry(value: unknown, index: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) {
    throw domainError("ipRuleExpiryInvalid", { index: index + 1 }, { status: 400 });
  }
  return new Date(at).toISOString();
}

export function sanitizeIpRules(value: unknown): IpRule[] {
  if (!Array.isArray(value)) throw domainError("ipRulesInvalid", {}, { status: 400 });
  if (value.length > MAX_IP_RULES) {
    throw domainError("ipRulesTooMany", { max: MAX_IP_RULES }, { status: 400 });
  }
  return value.map((item, index) => {
    const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const action = raw.action;
    const texts = {
      cidr: textOf(raw.cidr),
      hostname: textOf(raw.hostname),
      country: textOf(raw.country),
      continent: textOf(raw.continent),
      asn: textOf(raw.asn),
    };
    const given = Object.values(texts).filter(Boolean).length;
    const only = given === 1;
    const rule: IpRule = {
      action: action as IpRuleAction,
      cidr: only && texts.cidr ? normalizeCidr(texts.cidr) : null,
      hostname: only && texts.hostname ? normalizeRuleHostname(texts.hostname) : null,
      country: only && texts.country ? normalizeCountry(texts.country) : null,
      continent: only && texts.continent ? normalizeContinent(texts.continent) : null,
      asn: only && texts.asn ? normalizeAsn(texts.asn) : null,
      note: null,
      expiresAt: null,
    };
    const hasTarget = Boolean(
      rule.cidr || rule.hostname || rule.country || rule.continent || rule.asn,
    );
    if (!(IP_RULE_ACTIONS as readonly unknown[]).includes(action) || !hasTarget) {
      throw domainError("ipRuleInvalid", { index: index + 1 }, { status: 400 });
    }
    const note = typeof raw.note === "string" ? raw.note.trim().slice(0, MAX_NOTE_LENGTH) : "";
    rule.note = note || null;
    rule.expiresAt = normalizeRuleExpiry(raw.expiresAt ?? raw.expires_at, index);
    return rule;
  });
}

/**
 * Null keeps the plain 403. A body may hold anything but control characters; a redirect must be an
 * absolute http(s) URL with no placeholder, since Caddy would expand one from the request.
 */
export function sanitizeDenyResponse(value: unknown): DenyResponse | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw domainError("accessListDenyInvalid", {}, { status: 400 });
  const raw = value as Record<string, unknown>;
  const redirectText = textOf(raw.redirectUrl ?? raw.redirect_url);
  if (redirectText) {
    let url: URL | null = null;
    try {
      url = new URL(redirectText);
    } catch {
      url = null;
    }
    if (
      !url ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      /[{}\s]/.test(redirectText) ||
      redirectText.length > MAX_DENY_REDIRECT_LENGTH
    ) {
      throw domainError("accessListDenyRedirectInvalid", {}, { status: 400 });
    }
    return { status: 302, body: null, redirectUrl: redirectText };
  }
  const statusRaw = raw.status ?? raw.statusCode;
  const status =
    statusRaw === null || statusRaw === undefined || statusRaw === ""
      ? DEFAULT_DENY_STATUS
      : Number(statusRaw);
  if (!Number.isInteger(status) || status < DENY_STATUS_MIN || status > DENY_STATUS_MAX) {
    throw domainError(
      "accessListDenyStatusInvalid",
      { min: DENY_STATUS_MIN, max: DENY_STATUS_MAX },
      { status: 400 },
    );
  }
  const body = typeof raw.body === "string" ? raw.body : "";
  // Tabs and line breaks are fine in a page; other control characters are not.
  if (body.length > MAX_DENY_BODY_LENGTH || hasControlCharacter(body)) {
    throw domainError("accessListDenyBodyInvalid", { max: MAX_DENY_BODY_LENGTH }, { status: 400 });
  }
  if (status === DEFAULT_DENY_STATUS && !body.trim()) return null;
  return { status, body: body.trim() ? body : null, redirectUrl: null };
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

/** static_response expands placeholders in its body; a page's own braces must stay literal. */
function escapePlaceholders(text: string): string {
  return text.replace(/[{}]/g, (brace) => `\\${brace}`);
}

const DENY = { handler: "static_response", status_code: 403, body: DEFAULT_DENY_BODY };

/** Caddy's own response, for routes decided by `client_ip`. */
function denyHandler(deny: DenyResponse | undefined): Record<string, unknown> {
  if (!deny) return DENY;
  if (deny.redirectUrl) {
    return {
      handler: "static_response",
      status_code: 302,
      headers: { Location: [deny.redirectUrl] },
    };
  }
  return {
    handler: "static_response",
    status_code: deny.status,
    body: escapePlaceholders(deny.body ?? DEFAULT_DENY_BODY),
  };
}

/** The same answer in the blocker's own fields, which it writes verbatim. */
function blockerResponse(deny: DenyResponse | undefined): Record<string, unknown> {
  if (deny?.redirectUrl) return { redirect_url: deny.redirectUrl };
  return {
    response_status: deny?.status ?? DEFAULT_DENY_STATUS,
    response_body: deny?.body ?? DEFAULT_DENY_BODY,
  };
}

/** What `satisfy any` answers an unadmitted visitor: a prompt for the list's password. */
const PASSWORD_CHALLENGE = {
  response_status: 401,
  response_body: "Unauthorized",
  response_headers: { "WWW-Authenticate": 'Basic realm="restricted"' },
};

function basicAuth(accounts: AccessListRuntime["accounts"]): Record<string, unknown> {
  return {
    handler: "authentication",
    providers: {
      http_basic: {
        accounts: accounts.map((entry) => ({
          username: entry.username,
          password: entry.passwordHash,
        })),
      },
    },
  };
}

/** Every address, for a default of deny with no ranges above it to exclude. */
const EVERY_ADDRESS = ["0.0.0.0/0", "::/0"];

/**
 * The matcher sets - any one matching - for the addresses a list's IP rules deny. First matching
 * rule decides, so each deny excludes every range above it. `client_ip` honours the HTTP server's
 * trusted_proxies; layer 4 has only `remote_ip`. A rule with no ranges (a name that has not
 * resolved) is skipped: an allow then admits nobody and a deny denies nobody.
 */
export function ipDenyMatcherSets(
  list: Pick<AccessListRuntime, "ipRules" | "ipDefault">,
  matcher: "client_ip" | "remote_ip",
): Record<string, unknown>[] {
  const sets: Record<string, unknown>[] = [];
  const above: string[] = [];
  for (const rule of list.ipRules) {
    if (rule.ranges.length === 0) continue;
    if (rule.action === "deny") {
      const set: Record<string, unknown> = { [matcher]: { ranges: [...rule.ranges] } };
      if (above.length > 0) set.not = [{ [matcher]: { ranges: [...above] } }];
      sets.push(set);
    }
    above.push(...rule.ranges);
  }
  if (list.ipDefault === "deny") {
    // A `not` of no ranges reads differently per matcher, so "everyone" is spelled out.
    sets.push(
      above.length > 0
        ? { not: [{ [matcher]: { ranges: above } }] }
        : { [matcher]: { ranges: [...EVERY_ADDRESS] } },
    );
  }
  return sets;
}

/** No route is terminal: inside a subroute that ends the request with an empty 200. */
function ipSubroute(list: AccessListRuntime, onDeny: Record<string, unknown>[]) {
  const routes = ipDenyMatcherSets(list, "client_ip").map((set) => ({
    match: [set],
    handle: onDeny,
  }));
  return tagOutcome({ handler: "subroute", routes }, "access");
}

/** What one rule, or a run of them, matches, in the blocker's terms. */
type BlockerTarget = { cidrs: string[]; countries: string[]; continents: string[]; asns: number[] };

const emptyTarget = (): BlockerTarget => ({ cidrs: [], countries: [], continents: [], asns: [] });

function addRule(target: BlockerTarget, rule: RuntimeIpRule): void {
  const add = <T>(into: T[], items: readonly T[] | undefined) => {
    for (const item of items ?? []) if (!into.includes(item)) into.push(item);
  };
  add(target.cidrs, rule.ranges);
  add(target.countries, rule.countries);
  add(target.continents, rule.continents);
  add(target.asns, rule.asns);
}

const hasTarget = (rule: RuntimeIpRule) =>
  rule.ranges.length > 0 ||
  Boolean(rule.countries?.length || rule.continents?.length || rule.asns?.length);

/** One blocker's decision: deny what `block` matches unless `allow` does too. */
export type BlockerDecision = { block: BlockerTarget; allow: BlockerTarget; isDefault: boolean };

/**
 * The first matching rule decides, as with `client_ip`. A deny only needs the allows above it
 * excluded, since a deny above refuses the same client anyway, so a run of denies shares one
 * blocker. A default of deny blocks everyone no allow admitted.
 */
export function blockerDecisions(
  list: Pick<AccessListRuntime, "ipRules" | "ipDefault">,
): BlockerDecision[] {
  const decisions: BlockerDecision[] = [];
  const allowAbove = emptyTarget();
  let run: BlockerTarget | null = null;
  const snapshot = (target: BlockerTarget): BlockerTarget => ({
    cidrs: [...target.cidrs],
    countries: [...target.countries],
    continents: [...target.continents],
    asns: [...target.asns],
  });
  for (const rule of list.ipRules) {
    if (!hasTarget(rule)) continue;
    if (rule.action === "deny") {
      run ??= emptyTarget();
      addRule(run, rule);
      continue;
    }
    if (run) {
      decisions.push({ block: run, allow: snapshot(allowAbove), isDefault: false });
      run = null;
    }
    addRule(allowAbove, rule);
  }
  if (run) decisions.push({ block: run, allow: snapshot(allowAbove), isDefault: false });
  if (list.ipDefault === "deny") {
    decisions.push({
      block: { ...emptyTarget(), cidrs: [...EVERY_ADDRESS] },
      allow: snapshot(allowAbove),
      isDefault: true,
    });
  }
  return decisions;
}

const GEOIP_DB = "/usr/share/GeoIP/GeoLite2-Country.mmdb";
const ASN_DB = "/usr/share/GeoIP/GeoLite2-ASN.mmdb";

/** The rule fields shared by the HTTP handler and the layer 4 matcher. */
function blockerRules(decision: BlockerDecision): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const { block, allow } = decision;
  const places = [block.countries, block.continents, allow.countries, allow.continents];
  if (places.some((codes) => codes.length > 0)) out.geoip_db = GEOIP_DB;
  if (block.asns.length || allow.asns.length) out.asn_db = ASN_DB;
  if (block.countries.length) out.block_countries = block.countries;
  if (block.continents.length) out.block_continents = block.continents;
  if (block.asns.length) out.block_asns = block.asns;
  if (block.cidrs.length) out.block_cidrs = block.cidrs;
  if (allow.countries.length) out.allow_countries = allow.countries;
  if (allow.continents.length) out.allow_continents = allow.continents;
  if (allow.asns.length) out.allow_asns = allow.asns;
  if (allow.cidrs.length) out.allow_cidrs = allow.cidrs;
  return out;
}

/**
 * The list's rules as blocker handlers, each answering with `response`. The client the blocker
 * cannot place falls to the default: refused under a default of deny, as an unmatched one is.
 */
function blockerHandlers(
  list: AccessListRuntime,
  response: Record<string, unknown>,
): Record<string, unknown>[] {
  return blockerDecisions(list).map((decision) => {
    const handler: Record<string, unknown> = {
      handler: "blocker",
      ...blockerRules(decision),
      ...response,
    };
    if (list.trustedProxies?.length) handler.trusted_proxies = [...list.trustedProxies];
    if (decision.isDefault) handler.fail_closed = true;
    return tagOutcome(handler, "access");
  });
}

/**
 * `satisfy any` with geo rules. The blocker can only answer or pass, never hand over to the
 * password check, so a visitor sending credentials is checked on them alone and everyone else on
 * the rules, refused with a password prompt.
 */
function blockerSatisfyAny(list: AccessListRuntime): Record<string, unknown> {
  const hasCredentials = { header: { Authorization: ["*"] } };
  return tagOutcome(
    {
      handler: "subroute",
      routes: [
        { match: [hasCredentials], handle: [basicAuth(list.accounts)] },
        {
          match: [{ not: [hasCredentials] }],
          handle: blockerHandlers(list, PASSWORD_CHALLENGE),
        },
      ],
    },
    "access",
  );
}

/** Refuses only a request whose client the blocker cannot place; no rules of its own. */
function failClosedHandler(list: AccessListRuntime): Record<string, unknown> | null {
  if (!list.failClosed || !list.blockerUsable || !list.trustedProxies?.length) return null;
  return tagOutcome(
    {
      handler: "blocker",
      trusted_proxies: [...list.trustedProxies],
      fail_closed: true,
      ...blockerResponse(list.deny),
    },
    "access",
  );
}

/** Whether a list needs the blocker module to be enforced as written. */
export function listNeedsBlocker(list: Pick<AccessListRuntime, "ipRules">): boolean {
  return list.ipRules.some((rule) =>
    Boolean(rule.countries?.length || rule.continents?.length || rule.asns?.length),
  );
}

/** The handlers a host (or one of its location rules) puts in its chain for this list. */
export function buildAccessListHandlers(list: AccessListRuntime): Record<string, unknown>[] {
  const hasAccounts = list.accounts.length > 0;
  const hasIpRules = list.ipRules.length > 0;
  const geo = listNeedsBlocker(list);

  const handlers: Record<string, unknown>[] = [];
  const failClosed = failClosedHandler(list);
  if (failClosed) handlers.push(failClosed);

  // Fail closed: a list with nothing in it admits nobody.
  if (!hasAccounts && !hasIpRules) {
    return [...handlers, tagOutcome({ ...denyHandler(list.deny) }, "access")];
  }

  if (hasIpRules && hasAccounts && list.satisfy === "any") {
    // An allowed address walks in; everyone else is asked for the password.
    handlers.push(geo ? blockerSatisfyAny(list) : ipSubroute(list, [basicAuth(list.accounts)]));
  } else {
    if (hasIpRules) {
      handlers.push(
        ...(geo
          ? blockerHandlers(list, blockerResponse(list.deny))
          : [ipSubroute(list, [denyHandler(list.deny)])]),
      );
    }
    if (hasAccounts) handlers.push(basicAuth(list.accounts));
  }
  // The upstream sees CPM's gate credentials only when the list says it should.
  if (hasAccounts && !list.passAuth) {
    handlers.push({ handler: "headers", request: { delete: ["Authorization"] } });
  }
  return handlers;
}

/**
 * Layer 4 matcher sets for the connections a list refuses. The blocker matcher has no trusted
 * proxies there: a connection's peer is the client.
 */
export function l4DenyMatcherSets(
  list: Pick<AccessListRuntime, "ipRules" | "ipDefault">,
): Record<string, unknown>[] {
  if (!listNeedsBlocker(list)) return ipDenyMatcherSets(list, "remote_ip");
  return blockerDecisions(list).map((decision) => ({ blocker: blockerRules(decision) }));
}
