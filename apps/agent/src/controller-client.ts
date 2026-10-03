/**
 * Everything the agent says to its controller, and the one stream it listens on. The agent always
 * dials, so a host behind NAT needs no inbound port. Requests are HMAC-signed and the secret never
 * travels, so it cannot be lifted from a proxy log.
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  type AgentAnalyticsKind,
  type AgentAnalyticsResult,
  type AgentCommandResult,
  type CertificateFileResult,
  type CertificateFilesAck,
  type AgentPairRequest,
  type AgentPairResponse,
  type AgentServerEvent,
  type AgentStatus,
  AGENT_OPERATIONS,
  CONTROLLER_AGENT_ROUTES,
  signatureBase,
  type AgentPairPreviewRequest,
  type AgentPairPreviewResponse,
} from "@cpm/shared";

/** Pairing targets an address an operator just typed, so fail fast on a typo. */
const PAIR_TIMEOUT_MS = 15_000;

const POST_TIMEOUT_MS = 15_000;

/** A relayed batch can be megabytes, written to ClickHouse before the controller answers. */
const ANALYTICS_TIMEOUT_MS = 60_000;

/** Hex SHA-256 of a request body (of "" when there is none), for the signature base. */
async function sha256Hex(body: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex");
}

export class ControllerUnreachable extends Error {
  constructor(url: string, cause: unknown) {
    super(`Could not reach the controller at ${url}: ${describe(cause)}`);
    this.name = "ControllerUnreachable";
  }
}

/**
 * The controller answered no. Distinct from `ControllerUnreachable`: a 401 invalidates the stored
 * secret, while an unreachable controller is a blip to retry through.
 */
export class ControllerRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControllerRejected";
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** A plain 500 has no JSON at all. */
async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Not JSON; the status line is all there is.
  }
  return fallback;
}

export class ControllerClient {
  constructor(
    private readonly url: string,
    private readonly agentId: string,
  ) {}

  get controllerUrl(): string {
    return this.url;
  }

  /** Who a code would pair with, without spending it. Null if the controller predates the route. */
  async previewPair(request: AgentPairPreviewRequest): Promise<AgentPairPreviewResponse | null> {
    const response = await this.send(
      CONTROLLER_AGENT_ROUTES.pairPreview,
      "POST",
      JSON.stringify(request),
      PAIR_TIMEOUT_MS,
      null,
    );
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) {
      throw new ControllerRejected(
        response.status,
        await errorMessage(
          response,
          `The controller refused the pairing code (${response.status}).`,
        ),
      );
    }
    return (await response.json()) as AgentPairPreviewResponse;
  }

  /** Exchange a one-time code for the secret - unsigned, as there is nothing to sign with yet. */
  async pair(request: AgentPairRequest): Promise<AgentPairResponse> {
    const response = await this.send(
      CONTROLLER_AGENT_ROUTES.pair,
      "POST",
      JSON.stringify(request),
      PAIR_TIMEOUT_MS,
      null,
    );
    if (!response.ok) {
      throw new ControllerRejected(
        response.status,
        await errorMessage(
          response,
          `The controller refused the pairing code (${response.status}).`,
        ),
      );
    }
    return (await response.json()) as AgentPairResponse;
  }

  /**
   * GraphQL refuses with 200 and an `errors` array, so checking `response.ok` alone would treat
   * "that agent is not connected" as success; the status is checked first, then the body.
   */
  private async operation<T>(
    secret: string,
    query: string,
    variables: Record<string, unknown>,
    timeoutMs = POST_TIMEOUT_MS,
  ): Promise<T> {
    const body = JSON.stringify({ query, variables });
    const response = await this.send(
      CONTROLLER_AGENT_ROUTES.graphql,
      "POST",
      body,
      timeoutMs,
      secret,
    );

    if (!response.ok) {
      throw new ControllerRejected(
        response.status,
        await errorMessage(response, `The controller refused the request (${response.status}).`),
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: GraphQLErrorShape[];
    } | null;

    const failure = payload?.errors?.[0];
    if (failure) {
      // Only a 401 stops the lifecycle retrying a secret that will never be accepted again;
      // flattening every refusal to one code would leave an unpaired agent looping forever.
      throw new ControllerRejected(statusForError(failure), failure.message ?? "Request refused.");
    }
    if (!payload?.data) {
      throw new ControllerRejected(response.status, "The controller returned no data.");
    }
    return payload.data;
  }

  async postStatus(secret: string, status: AgentStatus): Promise<void> {
    await this.operation(secret, AGENT_OPERATIONS.status, { status });
  }

  /** A request of its own because SSE has no client-to-server channel. */
  async postResults(secret: string, results: AgentCommandResult[]): Promise<void> {
    if (results.length === 0) return;
    await this.operation(secret, AGENT_OPERATIONS.commandResults, { results });
  }

  async postCertificateFiles(
    secret: string,
    results: CertificateFileResult[],
  ): Promise<CertificateFilesAck> {
    const data = await this.operation<{ agentCertificateFiles: CertificateFilesAck }>(
      secret,
      AGENT_OPERATIONS.certificateFiles,
      { results },
    );
    const resend = data.agentCertificateFiles?.resend;
    return { resend: Array.isArray(resend) ? resend.filter(Number.isInteger) : [] };
  }

  async postAnalytics(
    secret: string,
    kind: AgentAnalyticsKind,
    rows: readonly unknown[],
  ): Promise<AgentAnalyticsResult> {
    const data = await this.operation<{ agentAnalytics: AgentAnalyticsResult }>(
      secret,
      AGENT_OPERATIONS.analytics,
      { kind, rows },
      ANALYTICS_TIMEOUT_MS,
    );
    return data.agentAnalytics;
  }

  /**
   * No overall timeout: the stream stays open as long as the agent runs, and the protocol's `ping`
   * event is the liveness check a timeout could not tell apart from an idle fleet.
   */
  async *events(secret: string, signal: AbortSignal): AsyncGenerator<AgentServerEvent> {
    const response = await this.send(
      CONTROLLER_AGENT_ROUTES.graphql,
      "POST",
      JSON.stringify({ query: AGENT_OPERATIONS.events }),
      null,
      secret,
      signal,
      { accept: "text/event-stream" },
    );

    if (!response.ok) {
      throw new ControllerRejected(
        response.status,
        await errorMessage(response, `The controller refused the stream (${response.status}).`),
      );
    }
    if (!response.body) {
      throw new ControllerRejected(response.status, "The controller's event stream had no body.");
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;

        // A config push large enough to span TCP segments routinely leaves a partial frame here.
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseFrame(frame);
          if (event) yield event;
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => {
        // The stream is being torn down either way; a cancel that fails changes nothing.
      });
    }
  }

  /**
   * `secret` null means unsigned (pairing only). The signature covers method, path, timestamp,
   * nonce and body hash, so a captured request cannot be replayed elsewhere, twice, or late.
   */
  private async send(
    path: string,
    method: string,
    body: string,
    timeoutMs: number | null,
    secret: string | null,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      [AGENT_ID_HEADER]: this.agentId,
      ...extraHeaders,
    };
    if (method !== "GET") headers["content-type"] = "application/json";

    if (secret) {
      const timestamp = Date.now();
      const nonce = randomBytes(16).toString("hex");
      headers[AGENT_TIMESTAMP_HEADER] = String(timestamp);
      headers[AGENT_NONCE_HEADER] = nonce;
      headers[AGENT_SIGNATURE_HEADER] = createHmac("sha256", secret)
        .update(signatureBase(method, path, timestamp, await sha256Hex(body), nonce))
        .digest("hex");
    }

    try {
      return await fetch(`${this.url}${path}`, {
        method,
        headers,
        ...(method === "GET" ? {} : { body }),
        signal: signal ?? (timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)),
      });
    } catch (cause) {
      throw new ControllerUnreachable(this.url, cause);
    }
  }
}

type GraphQLErrorShape = { message?: string; extensions?: { code?: unknown } };

/**
 * Maps `extensions.code` to HTTP-ish codes. 401 drops the agent to idle and anything else retries,
 * so a missed 401 loops forever and a false one discards a pairing. Untagged errors retry.
 */
function statusForError(error: GraphQLErrorShape): number {
  switch (error.extensions?.code) {
    case "AGENT_UNAUTHORIZED":
      return 401;
    case "AGENT_NOT_CONNECTED":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    default:
      return 400;
  }
}

/** Null for frames with no payload, like the `:` keepalives that outlast proxy idle timeouts. */
function parseFrame(frame: string): AgentServerEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return null;

  let payload: { data?: { agentEvents?: AgentServerEvent }; errors?: GraphQLErrorShape[] };
  try {
    payload = JSON.parse(data);
  } catch {
    // A badly written frame must not take the subscription down; the next one may be fine.
    return null;
  }

  // An `errors` frame is a resolver failing mid-stream: nothing to act on, and the controller
  // closes the subscription if it is really over.
  if (payload.errors?.length) {
    const failure = payload.errors[0] ?? {};
    // Thrown so the lifecycle sees a forgotten agent here too, instead of retrying a dead secret.
    if (statusForError(failure) === 401) {
      throw new ControllerRejected(401, failure.message ?? "The controller refused the stream.");
    }
    console.warn(
      "[controller] The event subscription reported an error:",
      failure.message ?? "unknown",
    );
    return null;
  }
  return payload.data?.agentEvents ?? null;
}
