/**
 * Getting a batch of records to a sink. Every network target is resolved through the outbound
 * client's check and connected to by the address it checked; nothing here retries, the delivery
 * loop does. A batch either arrives whole or the call throws, so the cursor only moves past it.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { dataDirectory } from "../backup/storage";
import { DomainError, domainError } from "../errors/domain-error";
import {
  OutboundError,
  outboundFetch,
  type Resolver,
  resolveCheckedAddress,
} from "../http/outbound";
import type { StreamRecord } from "./records";
import { DEFAULT_PORTS, DEFAULT_HEADER_NAME, type Sink, type SinkEncoding } from "./sinks";
import { DEFAULT_DATAGRAM_BYTES, formatDatagram, formatSyslog, octetFrame } from "./syslog";

const CONNECT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;

let resolver: Resolver | undefined;

/** Test seam: where names resolve. */
export function setResolverForTests(resolve: Resolver | null): void {
  resolver = resolve ?? undefined;
}

export function auditStreamDirectory(): string {
  return join(dataDirectory(), "audit-stream");
}

/** On top of the system's, so a sink with its own CA can still reach a public receiver. */
function trusted(ca: string | undefined): string[] | undefined {
  return ca ? [...rootCertificates, ca] : undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the page and the alert say: a code for the reader's language, the English beside it. */
function failure(error: unknown, target: string): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof OutboundError) {
    if (error.code === "metadata") return domainError("auditSinkMetadata");
    if (error.code === "tls") return domainError("auditSinkTls", { target, reason: error.message });
    if (error.code === "connect-timeout" || error.code === "timeout") {
      return domainError("auditSinkTimeout", { target });
    }
  }
  return domainError("auditSinkUnreachable", { target, reason: reasonOf(error) });
}

// ── Syslog ──────────────────────────────────────────────────────────────────

async function sendUdp(address: string, family: 4 | 6, port: number, datagrams: Buffer[]) {
  let drained: (() => void) | null = null;
  const socket = await Bun.udpSocket({
    hostname: family === 6 ? "::" : "0.0.0.0",
    socket: {
      drain() {
        drained?.();
      },
    },
  });
  try {
    for (const datagram of datagrams) {
      // false is backpressure: the datagram was not sent, so it waits for room and goes again.
      while (!socket.send(datagram, port, address)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("send buffer stayed full")), 5_000);
          drained = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  } finally {
    socket.close();
  }
}

/**
 * One connection per batch. Over TLS nothing is written until the handshake has verified the
 * certificate for `serverName`: Bun reports a bad one there rather than failing the connect.
 */
function sendStream(
  address: string,
  port: number,
  tls: { serverName: string; ca?: string } | null,
  payload: Buffer,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let offset = 0;
    let settled = false;
    const finish = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(sendTimer);
      if (error) reject(error);
      else resolve();
    };
    const connectTimer = setTimeout(
      () => finish(new OutboundError("connect-timeout", "connect timed out")),
      CONNECT_TIMEOUT_MS,
    );
    const sendTimer = setTimeout(
      () => finish(new OutboundError("timeout", "send timed out")),
      SEND_TIMEOUT_MS,
    );
    const write = (socket: Bun.Socket) => {
      clearTimeout(connectTimer);
      while (offset < payload.length) {
        const written = socket.write(payload.subarray(offset));
        if (written <= 0) return;
        offset += written;
      }
      socket.end();
      finish(null);
    };
    Bun.connect({
      hostname: address,
      port,
      ...(tls ? { tls: { serverName: tls.serverName, ca: trusted(tls.ca) } } : {}),
      socket: {
        open(socket) {
          if (!tls) write(socket);
        },
        handshake(socket, success, authorizationError) {
          if (!success || authorizationError) {
            socket.end();
            finish(
              new OutboundError("tls", authorizationError?.message ?? "certificate not trusted"),
            );
            return;
          }
          write(socket);
        },
        drain(socket) {
          if (!settled) write(socket);
        },
        data() {},
        close() {
          if (offset < payload.length) finish(new Error("connection closed"));
        },
        error(_socket, error) {
          finish(error);
        },
        connectError(_socket, error) {
          finish(error);
        },
      },
    }).catch(finish);
  });
}

async function sendSyslog(sink: Sink, records: StreamRecord[]): Promise<void> {
  const kind = sink.kind as keyof typeof DEFAULT_PORTS;
  const host = sink.config.host ?? "";
  const port = sink.config.port ?? DEFAULT_PORTS[kind];
  const target = `${host}:${port}`;
  try {
    const { address, family } = await resolveCheckedAddress(host, resolver);
    if (kind === "syslog-udp") {
      const max = sink.config.maxBytes ?? DEFAULT_DATAGRAM_BYTES;
      await sendUdp(
        address,
        family,
        port,
        records.map((record) => formatDatagram(record, max)),
      );
      return;
    }
    const payload = Buffer.concat(records.map((record) => octetFrame(formatSyslog(record))));
    await sendStream(
      address,
      port,
      kind === "syslog-tls" ? { serverName: host, ca: sink.config.ca } : null,
      payload,
    );
  } catch (error) {
    throw failure(error, target);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

export function ndjson(records: StreamRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function encode(body: string, encoding: SinkEncoding): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(body);
  if (encoding === "gzip") return Bun.gzipSync(bytes) as Uint8Array<ArrayBuffer>;
  if (encoding === "zstd") return Bun.zstdCompressSync(bytes) as Uint8Array<ArrayBuffer>;
  return bytes;
}

export type HttpHooks = {
  /** A 415 to a compressed body: told once, then the batch goes again uncompressed. */
  onEncodingRefused?: () => Promise<void>;
};

async function sendHttp(sink: Sink, records: StreamRecord[], hooks: HttpHooks): Promise<void> {
  const url = sink.secret.url ?? "";
  const origin = URL.canParse(url) ? new URL(url).origin : url;
  let encoding: SinkEncoding = sink.encodingFallback
    ? "identity"
    : (sink.config.encoding ?? "identity");
  const body = ndjson(records);
  for (;;) {
    const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
    if (encoding !== "identity") headers["content-encoding"] = encoding;
    if (sink.secret.headerValue) {
      headers[sink.config.headerName ?? DEFAULT_HEADER_NAME] = sink.secret.headerValue;
    }
    let response: Response;
    try {
      response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: encode(body, encoding),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        timeoutMs: SEND_TIMEOUT_MS,
        ca: trusted(sink.config.ca),
        resolve: resolver,
      });
    } catch (error) {
      throw failure(error, origin);
    }
    if (response.ok) return;
    // No negotiation exists for request bodies: a 415 is the receiver saying it cannot decode.
    if (response.status === 415 && encoding !== "identity") {
      await hooks.onEncodingRefused?.();
      encoding = "identity";
      continue;
    }
    throw domainError("auditSinkHttpStatus", { status: response.status });
  }
}

// ── File ────────────────────────────────────────────────────────────────────

async function sendFile(sink: Sink, records: StreamRecord[]): Promise<void> {
  const dir = auditStreamDirectory();
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, sink.config.fileName ?? "audit.jsonl"), ndjson(records), {
      mode: 0o640,
    });
  } catch (error) {
    throw domainError("auditSinkFileFailed", { reason: reasonOf(error) });
  }
}

/** Sends `records`, in order, or throws a DomainError saying why not. */
export async function sendRecords(
  sink: Sink,
  records: StreamRecord[],
  hooks: HttpHooks = {},
): Promise<void> {
  if (records.length === 0) return;
  switch (sink.kind) {
    case "http":
      return sendHttp(sink, records, hooks);
    case "file":
      return sendFile(sink, records);
    default:
      return sendSyslog(sink, records);
  }
}
