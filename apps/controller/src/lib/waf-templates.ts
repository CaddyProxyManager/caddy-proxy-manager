/**
 * The WAF forms' quick templates. Each must pass filterCustomDirectives untouched, or clicking it
 * inserts a rule the save then refuses; tests/unit/waf-templates.test.ts holds them to that. Ids
 * differ so that inserting several at once does not collide.
 *
 * The path skips match REQUEST_FILENAME, the path Go has decoded once, and refuse any "..": the raw
 * REQUEST_URI of /api/../index.php or /api/%2e%2e/index.php starts with /api/, but Caddy forwards
 * it as is and an upstream resolving dot-segments serves /index.php. Coraza compiles @rx with
 * (?sm), so \A and \z anchor it: ^ and $ would also match at a decoded %0a.
 */
export const WAF_QUICK_TEMPLATES = [
  {
    id: "allowIp",
    snippet: `SecRule REMOTE_ADDR "@ipMatch 1.2.3.4" "id:9000,phase:1,allow,nolog,msg:'Allow IP'"`,
  },
  {
    // ctl:ruleEngine is refused, so a path is narrowed rule by rule rather than switched off.
    id: "skipRuleForPath",
    snippet: String.raw`SecRule REQUEST_FILENAME "@rx \A/api/(?:[^.]|\.[^.])*\.?\z" "id:9001,phase:1,pass,nolog,ctl:ruleRemoveById=942100"`,
  },
  {
    id: "skipXssRulesForPath",
    snippet: String.raw`SecRule REQUEST_FILENAME "@rx \A/api/(?:[^.]|\.[^.])*\.?\z" "id:9003,phase:1,pass,nolog,ctl:ruleRemoveByTag=attack-xss"`,
  },
  {
    id: "blockUserAgent",
    snippet: `SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:9002,phase:1,deny,status:403,log"`,
  },
] as const;

/**
 * Added to the ids in the host form, so a merge-mode host's template rules do not reuse the global
 * ones': the merged handler holds both, and Coraza refuses a duplicate id.
 */
export const HOST_TEMPLATE_ID_OFFSET = 100;

const TEMPLATE_ID = /\bid:(\d+)/;
// Every id-like number, commented-out and dropped rules included, so a picked id stays free.
const ANY_RULE_ID = /\bid[\s\u0085]*:[\s\u0085'"]*(\d+)/gi;

/** `directives` plus the template, its id moved past every id in use so a second click loads. */
export function appendQuickTemplate(
  directives: string,
  template: { snippet: string },
  idOffset = 0,
): string {
  const used = new Set([...directives.matchAll(ANY_RULE_ID)].map((match) => Number(match[1])));
  let id = Number(TEMPLATE_ID.exec(template.snippet)?.[1] ?? 0) + idOffset;
  while (used.has(id)) id++;
  const snippet = template.snippet.replace(TEMPLATE_ID, `id:${id}`);
  return directives ? `${directives}\n${snippet}` : snippet;
}
