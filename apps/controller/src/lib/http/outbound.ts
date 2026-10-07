/**
 * The one way the controller sends a request to an admin-supplied address (acme-dns, a CrowdSec
 * LAPI, webhooks, chat, audit sinks). The name is resolved inside the socket's own lookup, so the
 * address checked is the address connected to and DNS rebinding has no gap to slip through.
 * Private ranges stay allowed: the targets usually sit on the operator's own network.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isMetadataHost } from "./outbound-url";

export type OutboundErrorCode =
  | "invalid"
  | "metadata"
  | "insecure-redirect"
  | "too-many-redirects"
  | "connect-timeout"
  | "timeout"
  | "too-large"
  | "aborted"
  | "tls"
  | "network";

/** Carries a code for the caller to map to its own message; `message` is for logs only. */
export class OutboundError extends Error {
  readonly code: OutboundErrorCode;
  constructor(code: OutboundErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutboundError";
    this.code = code;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a name resolves to. Swappable so tests can make a name resolve anywhere. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/**
 * Every address `hostname` resolves to, refusing the lot if any is a metadata or link-local
 * address: a name that answers one safe and one unsafe address is not trusted to pick.
 */
export async function resolveCheckedAddresses(
  hostname: string,
  resolve: Resolver = systemResolver,
): Promise<ResolvedAddress[]> {
  const host = bare(hostname);
  if (isMetadataHost(host)) throw metadataError(host);
  const literal = isIP(host);
  if (literal) return [{ address: host, family: literal === 6 ? 6 : 4 }];
  let answers: ResolvedAddress[];
  try {
    answers = await resolve(host);
  } catch (error) {
    throw new OutboundError("network", `Could not resolve ${host}`, { cause: error });
  }
  if (answers.length === 0) throw new OutboundError("network", `${host} has no address`);
  const unsafe = answers.find((answer) => isMetadataHost(answer.address));
  if (unsafe) throw metadataError(`${host} (${unsafe.address})`);
  return answers;
}

/** One checked address to connect a raw socket to, such as a syslog sink's. */
export async function resolveCheckedAddress(
  hostname: string,
  resolve: Resolver = systemResolver,
): Promise<ResolvedAddress> {
  const [first] = await resolveCheckedAddresses(hostname, resolve);
  return first;
}

function metadataError(target: string): OutboundError {
  return new OutboundError("metadata", `Refused metadata or link-local address: ${target}`);
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void;

/**
 * A socket `lookup` that hands the connection the addresses it checked. Bun asks for the
 * `options.all` form today and Node for either, so both are answered.
 */
export function checkedLookup(
  resolve: Resolver = systemResolver,
  onRefused?: (error: OutboundError) => void,
): LookupFunction {
  return ((hostname: string, options: unknown, callback?: LookupCallback) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const opts = (typeof options === "object" && options !== null ? options : {}) as {
      all?: boolean;
      family?: number | string;
    };
    const family =
      opts.family === "IPv6" ? 6 : opts.family === "IPv4" ? 4 : Number(opts.family ?? 0);
    resolveCheckedAddresses(hostname, resolve).then(
      (answers) => {
        const usable =
          family === 4 || family === 6 ? answers.filter((a) => a.family === family) : answers;
        if (usable.length === 0) {
          const error = Object.assign(new Error(`${hostname} has no IPv${family} address`), {
            code: "ENOTFOUND",
          });
          cb(error, opts.all ? [] : "", undefined);
          return;
        }
        if (opts.all) cb(null, usable);
        else cb(null, usable[0].address, usable[0].family);
      },
      (error: unknown) => {
        if (error instanceof OutboundError) onRefused?.(error);
        cb(error as NodeJS.ErrnoException, opts.all ? [] : "", undefined);
      },
    );
  }) as LookupFunction;
}

export interface OutboundRequestInit {
  method?: string;
  headers?: HeadersInit;
  /** Send a compressed body by setting `Content-Encoding` yourself; nothing is negotiated. */
  body?: string | Uint8Array<ArrayBuffer> | null;
  /** "follow" (the default) takes at most three hops; "manual" hands back the 3xx. */
  redirect?: "follow" | "manual";
  signal?: AbortSignal;
  /** Until the socket is connected, TLS included. */
  connectTimeoutMs?: number;
  /** The whole exchange, every hop and the body included. */
  timeoutMs?: number;
  /** The response body is buffered, so it is capped. */
  maxResponseBytes?: number;
  /** Extra trusted certificate authorities, on top of the system's. */
  ca?: string | string[];
  resolve?: Resolver;
}

/** Shaped like `fetch` so a caller can take one in tests; the Response body is already read. */
export type OutboundFetch = (url: string | URL, init?: OutboundRequestInit) => Promise<Response>;

const MAX_REDIRECTS = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

interface Hop {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer | null;
}

function parseTarget(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundError("invalid", "Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OutboundError("invalid", `Unsupported protocol ${url.protocol}`);
  }
  if (isMetadataHost(url.hostname)) throw metadataError(url.hostname);
  return url;
}

function classify(error: unknown): OutboundError {
  if (error instanceof OutboundError) return error;
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)) {
    return new OutboundError("tls", message, { cause: error });
  }
  return new OutboundError("network", message, { cause: error });
}

function sendOnce(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | null,
  init: OutboundRequestInit,
  deadline: number,
): Promise<Hop> {
  return new Promise<Hop>((resolvePromise, rejectPromise) => {
    const isHttps = url.protocol === "https:";
    const maxBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    let refused: OutboundError | undefined;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
      outgoing[key] = value;
    });
    if (body) outgoing["content-length"] = String(body.byteLength);

    const request = (isHttps ? https : http).request({
      protocol: url.protocol,
      hostname: bare(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: outgoing,
      // A pooled socket would skip the lookup, and with it the check.
      agent: false,
      lookup: checkedLookup(init.resolve, (error) => {
        refused = error;
      }),
      ...(isHttps && init.ca ? { ca: init.ca } : {}),
    });

    const finish = (error: OutboundError | null, hop?: Hop) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
      if (error) {
        request.destroy();
        rejectPromise(error);
      } else if (hop) {
        resolvePromise(hop);
      }
    };
    const onAbort = () => finish(new OutboundError("aborted", "Request aborted"));
    if (init.signal?.aborted) return onAbort();
    init.signal?.addEventListener("abort", onAbort, { once: true });

    const remaining = Math.max(0, deadline - Date.now());
    timers.push(
      setTimeout(
        () => finish(new OutboundError("timeout", `No answer from ${url.host}`)),
        remaining,
      ),
    );
    const connectTimer = setTimeout(
      () => finish(new OutboundError("connect-timeout", `Could not connect to ${url.host}`)),
      Math.min(remaining, init.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
    );
    timers.push(connectTimer);
    request.once("socket", (socket) => {
      socket.once(isHttps ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });

    request.on("error", (error) => finish(refused ?? classify(error)));
    request.on("response", (response) => {
      clearTimeout(connectTimer);
      const status = response.statusCode ?? 0;
      const responseHeaders = new Headers();
      const raw = response.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) responseHeaders.append(raw[i], raw[i + 1]);
      if (Number(responseHeaders.get("content-length") ?? 0) > maxBytes) {
        return finish(new OutboundError("too-large", `Answer over ${maxBytes} bytes`));
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          finish(new OutboundError("too-large", `Answer over ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => finish(classify(error)));
      response.on("end", () =>
        finish(null, {
          status,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders,
          body: NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks),
        }),
      );
    });

    request.end(body ?? undefined);
  });
}

export const outboundFetch: OutboundFetch = async (input, init = {}) => {
  const deadline = Date.now() + (init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let url = parseTarget(input);
  let method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  let body = init.body == null ? null : Buffer.from(init.body);

  for (let hops = 0; ; hops++) {
    const hop = await sendOnce(url, method, headers, body, init, deadline);
    const location = hop.headers.get("location");
    if (init.redirect === "manual" || !REDIRECT_STATUSES.has(hop.status) || !location) {
      return new Response(hop.body ? new Uint8Array(hop.body) : null, {
        status: hop.status,
        statusText: hop.statusText,
        headers: hop.headers,
      });
    }
    if (hops >= MAX_REDIRECTS) {
      throw new OutboundError("too-many-redirects", `More than ${MAX_REDIRECTS} redirects`);
    }
    let next: URL;
    try {
      next = parseTarget(new URL(location, url));
    } catch (error) {
      throw error instanceof OutboundError && error.code === "metadata"
        ? error
        : new OutboundError("invalid", `Invalid redirect to ${location}`);
    }
    if (url.protocol === "https:" && next.protocol === "http:") {
      throw new OutboundError("insecure-redirect", `Refused redirect from https to ${next.origin}`);
    }
    // A credential meant for one origin does not travel to another.
    if (next.origin !== url.origin) headers.delete("authorization");
    if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === "POST")) {
      if (method !== "HEAD") method = "GET";
      body = null;
      for (const name of ["content-type", "content-encoding", "content-length"])
        headers.delete(name);
    }
    url = next;
  }
};
