/**
 * An access list as Caddy handlers. Pure, so the decision table is testable without a database.
 * An allowed address "passes" because a subroute route with no handlers carries on with the host.
 */
import { isIP } from "node:net";
import { domainError } from "../errors/domain-error";
import { tagOutcome } from "../caddy/outcome-markers";

export const IP_RULE_ACTIONS = ["allow", "deny"] as const;
export type IpRuleAction = (typeof IP_RULE_ACTIONS)[number];
export const ACCESS_LIST_SATISFY = ["all", "any"] as const;
export type AccessListSatisfy = (typeof ACCESS_LIST_SATISFY)[number];

/** Exactly one of `cidr` and `hostname`. */
export type IpRule = {
  action: IpRuleAction;
  cidr: string | null;
  hostname: string | null;
  note: string | null;
};

/** A rule as Caddy sees it. A hostname that has not resolved has no ranges. */
export type RuntimeIpRule = { action: IpRuleAction; ranges: readonly string[] };

export type AccessListRuntime = {
  accounts: { username: string; passwordHash: string }[];
  ipRules: RuntimeIpRule[];
  ipDefault: IpRuleAction;
  satisfy: AccessListSatisfy;
  passAuth: boolean;
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
    const version = isIP(text);
    return version === 4 ? `${text}/32` : version === 6 ? `${text}/128` : null;
  }
  const address = text.slice(0, slash);
  const prefix = text.slice(slash + 1);
  const version = isIP(address);
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

/** Hostnames become their ranges in place, so the first matching rule still decides. */
export function expandIpRules(
  rules: readonly Pick<IpRule, "action" | "cidr" | "hostname">[],
  lookup: (name: string) => readonly string[] | undefined,
): RuntimeIpRule[] {
  return rules.map((rule) => {
    if (rule.cidr) return { action: rule.action, ranges: [rule.cidr] };
    if (!rule.hostname) return { action: rule.action, ranges: [] };
    const { name, ipv6Prefix } = splitRuleHostname(rule.hostname);
    return { action: rule.action, ranges: hostnameRanges(lookup(name) ?? [], ipv6Prefix) };
  });
}

export function sanitizeIpRules(value: unknown): IpRule[] {
  if (!Array.isArray(value)) throw domainError("ipRulesInvalid", {}, { status: 400 });
  if (value.length > MAX_IP_RULES) {
    throw domainError("ipRulesTooMany", { max: MAX_IP_RULES }, { status: 400 });
  }
  return value.map((item, index) => {
    const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const action = raw.action;
    const cidrText = typeof raw.cidr === "string" ? raw.cidr.trim() : "";
    const hostnameText = typeof raw.hostname === "string" ? raw.hostname.trim() : "";
    const cidr = cidrText && !hostnameText ? normalizeCidr(cidrText) : null;
    const hostname = hostnameText && !cidrText ? normalizeRuleHostname(hostnameText) : null;
    if (!(IP_RULE_ACTIONS as readonly unknown[]).includes(action) || (!cidr && !hostname)) {
      throw domainError("ipRuleInvalid", { index: index + 1 }, { status: 400 });
    }
    const note = typeof raw.note === "string" ? raw.note.trim().slice(0, MAX_NOTE_LENGTH) : "";
    return { action: action as IpRuleAction, cidr, hostname, note: note || null };
  });
}

const DENY = { handler: "static_response", status_code: 403, body: "Access denied" };

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

/** The handlers a host (or one of its location rules) puts in its chain for this list. */
export function buildAccessListHandlers(list: AccessListRuntime): Record<string, unknown>[] {
  const hasAccounts = list.accounts.length > 0;
  const hasIpRules = list.ipRules.length > 0;

  // Fail closed: a list with nothing in it admits nobody.
  if (!hasAccounts && !hasIpRules) return [tagOutcome({ ...DENY }, "access")];

  const handlers: Record<string, unknown>[] = [];
  if (hasIpRules && hasAccounts && list.satisfy === "any") {
    // An allowed address walks in; everyone else is asked for the password.
    handlers.push(ipSubroute(list, [basicAuth(list.accounts)]));
  } else {
    if (hasIpRules) handlers.push(ipSubroute(list, [DENY]));
    if (hasAccounts) handlers.push(basicAuth(list.accounts));
  }
  // The upstream sees CPM's gate credentials only when the list says it should.
  if (hasAccounts && !list.passAuth) {
    handlers.push({ handler: "headers", request: { delete: ["Authorization"] } });
  }
  return handlers;
}
