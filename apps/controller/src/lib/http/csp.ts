const isDev = process.env.NODE_ENV === "development";

/** Extra sources a page needs, per directive - the sign-in CAPTCHA's, today. */
export type CspAdditions = {
  script?: readonly string[];
  frame?: readonly string[];
  connect?: readonly string[];
  style?: readonly string[];
};

function directives(extra: CspAdditions): string {
  const add = (sources: readonly string[] | undefined) =>
    sources && sources.length > 0 ? ` ${sources.join(" ")}` : "";
  return [
    // style-src still needs 'unsafe-inline' for React JSX inline style props
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${add(extra.style)}`,
    "font-src 'self' https://fonts.gstatic.com",
    // Not all https:, so a provider's `picture` claim stays blocked.
    "img-src 'self' data: blob: https://www.gravatar.com https://secure.gravatar.com",
    // maplibre-gl v6 loads its tile worker from a bundled static asset.
    "worker-src 'self' blob:",
    `connect-src 'self'${add(extra.connect)}`,
    ...(extra.frame && extra.frame.length > 0 ? [`frame-src${add(extra.frame)}`] : []),
    "frame-ancestors 'none'",
    // default-src covers neither; an injected <base> would re-point every relative URL.
    "base-uri 'none'",
    "object-src 'none'",
    // Browsers apply it to a form's redirects too, which is why logout redirects relatively.
    "form-action 'self'",
  ].join("; ");
}

/** Everything after script-src is the same on every other request, so it is joined once. */
const STATIC_DIRECTIVES = directives({});

/** A nonce-based CSP per request; Next.js reads the nonce from the CSP request header. */
export function buildCsp(nonce: string, extra?: CspAdditions): string {
  const scriptExtra = extra?.script?.length ? ` ${extra.script.join(" ")}` : "";
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'${scriptExtra}`
    : `script-src 'self' 'nonce-${nonce}'${scriptExtra}`;
  return `default-src 'self'; ${scriptSrc}; ${extra ? directives(extra) : STATIC_DIRECTIVES}`;
}

/** The nonce out of a policy `buildCsp` wrote, for a page that injects a script of its own. */
export function cspNonce(policy: string | null): string | undefined {
  return policy?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
}
