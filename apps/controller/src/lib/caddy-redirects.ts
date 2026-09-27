import type { RedirectRule } from "./models/proxy-hosts";

/** RE2 escaping for a literal path segment inside `path_regexp`. */
function escapeRegexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What "after prefix" strips: `/old/*` sends `/old/a/b` on as `/a/b`. */
export function redirectPrefix(from: string): string {
  const star = from.indexOf("*");
  return (star === -1 ? from : from.slice(0, star)).replace(/\/+$/, "");
}

export function buildRedirectRoute(rule: RedirectRule): Record<string, unknown> {
  if (!rule.preservePath) {
    return {
      match: [{ path: [rule.from] }],
      handle: [
        {
          handler: "static_response",
          status_code: rule.status,
          headers: { Location: [rule.to] },
        },
      ],
    };
  }

  // With a target of "/" or "", an appended "//evil.example" (or "/\") would be a
  // protocol-relative URL, so such requests are left unredirected.
  const base = rule.to.replace(/\/+$/, "");
  const unsafe: Record<string, unknown>[] = [{ path_regexp: { pattern: "^/[/\\\\]" } }];
  const handle: Record<string, unknown>[] = [];
  if (rule.preservePath === "suffix") {
    const prefix = redirectPrefix(rule.from);
    if (prefix) {
      unsafe.push({ path_regexp: { pattern: `(?i)^${escapeRegexp(prefix)}[/\\\\]{2}` } });
      handle.push({ handler: "rewrite", strip_path_prefix: prefix });
    }
  }
  handle.push({
    handler: "static_response",
    status_code: rule.status,
    headers: { Location: [`${base}{http.request.uri}`] },
  });

  return { match: [{ path: [rule.from], not: unsafe }], handle };
}
