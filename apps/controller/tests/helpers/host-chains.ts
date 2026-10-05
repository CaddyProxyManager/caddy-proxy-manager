/** Reads a built Caddy document back as the handler lists that end in a given upstream. */
import { isOutcomeMarker } from '../../src/lib/caddy/outcome-markers';

export type Handler = Record<string, unknown>;

/** Every handler list, nested subroutes included, whose reverse_proxy dials `upstream`. */
export function chainsTo(doc: unknown, upstream: string): Handler[][] {
  const chains: Handler[][] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const handle = (node as { handle?: Handler[] }).handle;
    if (
      Array.isArray(handle) &&
      handle.some(
        (h) => h?.handler === 'reverse_proxy' && JSON.stringify(h.upstreams).includes(upstream),
      )
    ) {
      chains.push(handle);
    }
    Object.values(node).forEach(walk);
  };
  walk(doc);
  return chains;
}

/** A short name per handler, so an order reads as a list. */
export function handlerLabel(handler: Handler): string {
  if (handler.handler === 'subroute') {
    const json = JSON.stringify(handler);
    if (json.includes('(?i)websocket')) return 'ws-refuse';
    if (json.includes('"status_code":503') && json.includes('no-store')) return 'maintenance';
    if (json.includes('"/robots.txt"')) return 'robots';
    if (json.includes('/.within.website/')) return 'anubis';
  }
  if (handler.handler === 'headers' && JSON.stringify(handler).includes('X-Robots-Tag')) {
    return 'x-robots-tag';
  }
  if (handler.handler === 'headers' && JSON.stringify(handler).includes('Strict-Transport')) {
    return 'hsts';
  }
  return String(handler.handler);
}

/** The outcome markers sit around every gate and say nothing about the order. */
export function withoutMarkers(chain: Handler[]): Handler[] {
  return chain.filter((handler) => !isOutcomeMarker(handler));
}

export function chainLabels(doc: unknown, upstream: string): string[][] {
  return chainsTo(doc, upstream).map((chain) => withoutMarkers(chain).map(handlerLabel));
}
