/**
 * Marks which gate answered a request, for analytics. Before each gate a `vars` sets the outcome to
 * that gate, after it to `served`, and `log_append` writes whatever is set when the request ends:
 * a request a gate refuses never reaches the marker after it.
 */

import { ACCESS_LOG_OUTCOME_FIELD, type TrafficOutcome } from "@cpm/shared";

type Handler = Record<string, unknown>;
type Route = { handle?: Handler[]; [key: string]: unknown };

const VAR = ACCESS_LOG_OUTCOME_FIELD;

/** Gates that are plain `subroute`s or `reverse_proxy`s, named where they are built. */
const TAGGED = new WeakMap<object, TrafficOutcome>();

export function tagOutcome<T extends Handler>(handler: T, outcome: TrafficOutcome): T {
  TAGGED.set(handler, outcome);
  return handler;
}

/** Plugin handlers are gates by name. `authentication` is basic auth and Tailscale's. */
const BY_NAME: Record<string, TrafficOutcome> = {
  crowdsec: "crowdsec",
  appsec: "crowdsec",
  rate_limit: "rate_limit",
  blocker: "geo",
  waf: "waf",
  authentication: "auth",
};

export function outcomeOf(handler: Handler): TrafficOutcome | null {
  return TAGGED.get(handler) ?? BY_NAME[String(handler.handler)] ?? null;
}

function marker(outcome: TrafficOutcome): Handler {
  return { handler: "vars", [VAR]: outcome };
}

export function isOutcomeMarker(handler: Handler): boolean {
  return (
    (handler.handler === "vars" && VAR in handler) ||
    (handler.handler === "log_append" && handler.key === VAR)
  );
}

/** Whether any handler at any depth of subroutes is a gate. */
function hasGate(handlers: readonly Handler[]): boolean {
  return handlers.some(
    (handler) =>
      outcomeOf(handler) !== null ||
      (handler.handler === "subroute" && routesHaveGate(handler.routes)),
  );
}

function routesHaveGate(routes: unknown): boolean {
  return (
    Array.isArray(routes) &&
    routes.some((route: Route) => Array.isArray(route?.handle) && hasGate(route.handle))
  );
}

/** A fresh array: route arrays share handler objects, never the arrays' own slots. */
function markChain(handlers: readonly Handler[]): Handler[] {
  const out: Handler[] = [];
  handlers.forEach((handler, index) => {
    if (handler.handler === "subroute" && Array.isArray(handler.routes)) {
      instrumentRoutes(handler.routes as Route[]);
    }
    const outcome = outcomeOf(handler);
    if (!outcome) {
      out.push(handler);
      return;
    }
    out.push(marker(outcome), handler);
    // Back-to-back gates need no `served` between them.
    const next = handlers[index + 1];
    if (!next || !outcomeOf(next)) out.push(marker("served"));
  });
  return out;
}

const marked = new WeakSet<object>();

function instrumentRoutes(routes: Route[]): void {
  for (const route of routes) {
    if (!Array.isArray(route?.handle) || marked.has(route) || !hasGate(route.handle)) continue;
    marked.add(route);
    route.handle = markChain(route.handle);
  }
}

/**
 * Rewrites a host's routes in place. Only a route with a gate is touched, so a host with none
 * builds exactly as before and logs no outcome, which the agent reads as `served`.
 */
export function instrumentOutcomes(routes: Route[]): void {
  for (const route of routes) {
    if (!Array.isArray(route?.handle) || marked.has(route) || !hasGate(route.handle)) continue;
    instrumentRoutes([route]);
    route.handle = [
      { handler: "log_append", key: VAR, value: `{http.vars.${VAR}}` },
      ...(route.handle as Handler[]),
    ];
  }
}
