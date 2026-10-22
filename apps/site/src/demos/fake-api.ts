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

/** Sends a named event to the stream's listeners. */
export type StreamEmit = (event: string, data: unknown) => void;
/** Starts a stream for a URL it answers, returning how to stop it, or null to leave it alone. */
export type StreamHandler = (url: URL, emit: StreamEmit) => (() => void) | null;

const streams = new Set<StreamHandler>();

if (typeof window !== "undefined") {
  // Each island bundles its own copy of this module, so this may be another copy's stand-in: a
  // stream none of ours answers falls through to it, as fetch above does.
  const PreviousEventSource = window.EventSource;
  class DemoEventSource extends EventTarget {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    stop: (() => void) | null = null;

    constructor(url: URL) {
      super();
      this.url = url.href;
      // A task later, so listeners added right after construction hear the open.
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    /** Deferred like the open, and dropped once closed. */
    readonly emit: StreamEmit = (event, data) => {
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
      });
    };

    close() {
      this.readyState = 2;
      this.stop?.();
      this.stop = null;
    }
  }
  // A class, since callers construct it with `new`; returning an object hands that back instead.
  class DemoAwareEventSource {
    // Callers compare readyState against these on the constructor.
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    constructor(url: string | URL, init?: EventSourceInit) {
      const target = new URL(String(url), location.href);
      if (target.origin === location.origin) {
        const source = new DemoEventSource(target);
        for (const handler of streams) {
          source.stop = handler(target, source.emit);
          // biome-ignore lint/correctness/noConstructorReturn: picks which EventSource to construct
          if (source.stop) return source;
        }
        source.readyState = 2;
      }
      // biome-ignore lint/correctness/noConstructorReturn: picks which EventSource to construct
      return new PreviousEventSource(url, init);
    }
  }
  window.EventSource = DemoAwareEventSource as unknown as typeof EventSource;
}

/** Until the returned function is called. */
export function serveStream(handler: StreamHandler): () => void {
  streams.add(handler);
  return () => {
    streams.delete(handler);
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
