/**
 * Answers the controller's `/api/...` routes in the browser. `fetch` is wrapped at import, not in
 * an effect: a child's effect runs before its parent's, so a mount fetch would go out first.
 */

/** Answers a request, or returns null to leave it to the next handler and then the network. */
export type ApiHandler = (url: URL, init: RequestInit | undefined) => Promise<Response | null>;

const handlers = new Set<ApiHandler>();

if (typeof window !== "undefined") {
  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin) {
      for (const handler of handlers) {
        const answer = await handler(url, init);
        if (answer) return answer;
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

/** Until the returned function is called. */
export function serveApi(handler: ApiHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
