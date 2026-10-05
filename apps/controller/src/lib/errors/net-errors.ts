/**
 * Recognising "the other end was not reachable" across runtimes. Bun 1.4 puts the code on
 * `TypeError.code` with no `.cause`, Node on `.cause.code`, and the names differ
 * (`ConnectionRefused` vs `ECONNREFUSED`). So match the union, walk `.cause` for wrapped errors,
 * and match the message too - the ClickHouse client keeps only text.
 */

/** Codes meaning "could not open a connection to the host". */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED", // Node, and Bun for some socket paths
  "ConnectionRefused", // Bun's fetch()
  "FailedToOpenSocket", // Bun, connection could not be established at all
  "ENOTFOUND", // DNS lookup failed
  "EAI_AGAIN", // DNS lookup failed, temporarily
  // Bun's DNS lookup timed out. What an internal Docker network gives for a service that is not
  // running: the embedded resolver forwards the unknown name upstream, and there is no upstream.
  "ETIMEOUT",
  "ECONNRESET", // peer closed mid-handshake
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

/**
 * Message fragments the runtimes use when no code survives wrapping. Narrow enough that an
 * application failure - a bad query, a 500 - cannot match by accident.
 */
const CONNECTION_ERROR_MESSAGES = [
  "ECONNREFUSED",
  "FailedToOpenSocket",
  "ENOTFOUND",
  "Unable to connect", // Bun 1.4: "Unable to connect. Is the computer able to access the url?"
  "Was there a typo in the url or port?", // Bun, older phrasing
];

/** Reads an error's `code`, whatever its declared type. */
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True when `error` - or anything it wraps - is a failure to reach the host. `depth` bounds the
 * `.cause` walk so a self-referential chain cannot spin.
 */
export function isConnectionError(error: unknown, depth = 4): boolean {
  if (!error || typeof error !== "object" || depth < 0) return false;

  const code = errorCode(error);
  if (code && CONNECTION_ERROR_CODES.has(code)) return true;

  if (error instanceof Error && CONNECTION_ERROR_MESSAGES.some((m) => error.message.includes(m))) {
    return true;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error && isConnectionError(cause, depth - 1)) return true;

  return false;
}
