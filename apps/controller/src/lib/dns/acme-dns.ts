/**
 * Registers an acme-dns account from the controller. The server URL is admin-supplied, so the
 * request is bounded: https unless the host is plainly local, an address checked at connect time, no
 * redirects, a timeout and a size cap, and only the four fields the module needs are kept.
 */

import { type AcmeDnsAccount, normalizeDnsName } from "./challenge-delegation";
import { domainError } from "../errors/domain-error";
import { type OutboundFetch, OutboundError, outboundFetch } from "../http/outbound";
import { parseOutboundBaseUrl } from "../http/outbound-url";

const REGISTER_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_FIELD_LENGTH = 256;

/** The base URL `/register` and the module's `/update` are resolved against. */
export function parseAcmeDnsServerUrl(raw: string): string {
  const parsed = parseOutboundBaseUrl(raw);
  if (parsed.problem === "metadata") throw domainError("outboundUrlMetadata", {}, { status: 400 });
  if (parsed.problem === "https") throw domainError("acmeDnsServerUrlHttps", {}, { status: 400 });
  if (parsed.problem) throw domainError("acmeDnsServerUrlInvalid", {}, { status: 400 });
  return parsed.url;
}

/** Counted as it streams: Content-Length is the sender's claim and may be absent. */
async function readCappedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw domainError("acmeDnsRegisterTooLarge", { max: MAX_RESPONSE_BYTES });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw domainError("acmeDnsRegisterTooLarge", { max: MAX_RESPONSE_BYTES });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > MAX_FIELD_LENGTH) {
    throw domainError("acmeDnsRegisterInvalidResponse");
  }
  return value;
}

/** Throws a DomainError the Settings screen renders; never follows a redirect. */
export async function registerAcmeDnsAccount(
  serverUrl: string,
  fetchImpl: OutboundFetch = outboundFetch,
): Promise<AcmeDnsAccount> {
  const base = parseAcmeDnsServerUrl(serverUrl);

  let response: Response;
  try {
    // outbound: acmeDns
    response = await fetchImpl(`${base}/register`, {
      method: "POST",
      headers: { Accept: "application/json" },
      redirect: "manual",
      timeoutMs: REGISTER_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    const code = error instanceof OutboundError ? error.code : undefined;
    if (code === "metadata") throw domainError("outboundUrlMetadata", {}, { status: 400 });
    if (code === "too-large")
      throw domainError("acmeDnsRegisterTooLarge", { max: MAX_RESPONSE_BYTES });
    throw domainError("acmeDnsRegisterUnreachable", { server: base });
  }
  if (response.status !== 201 && response.status !== 200) {
    await response.body?.cancel();
    throw domainError("acmeDnsRegisterStatus", { status: response.status });
  }

  const text = await readCappedText(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw domainError("acmeDnsRegisterInvalidResponse");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw domainError("acmeDnsRegisterInvalidResponse");
  }
  const record = body as Record<string, unknown>;
  const fulldomain = normalizeDnsName(field(record, "fulldomain"));
  if (!fulldomain) throw domainError("acmeDnsRegisterInvalidResponse");

  return {
    username: field(record, "username"),
    password: field(record, "password"),
    subdomain: field(record, "subdomain"),
    fulldomain,
    server_url: base,
  };
}
