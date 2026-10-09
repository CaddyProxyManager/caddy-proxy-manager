export const dynamic = "force-dynamic";

/**
 * `/waf/<tab>` is rewritten to the page (next.config.mjs), but the router asks for the browser's
 * URL again after a server action and not every such request goes through the rewrite; this
 * route answers those with the same page rather than a 404.
 */
export { default, generateMetadata } from "../page";
