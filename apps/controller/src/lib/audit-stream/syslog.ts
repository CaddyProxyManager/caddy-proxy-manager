/**
 * RFC 5424 messages, framed per RFC 6587 octet counting for TCP and TLS (RFC 5425) and one per
 * datagram for UDP (RFC 5426). The chain fields ride in structured data as well as in the JSON,
 * so cutting a datagram down to size never loses them.
 */

import { hostname } from "node:os";
import type { StreamRecord } from "./records";

/** RFC 5612's documentation number: CPM has no IANA enterprise number of its own. */
export const SD_ID = "cpm@32473";
const APP_NAME = "cpm";
/** "log audit". */
const FACILITY = 13;
const SEVERITY = { audit: 5, security: 4, gap: 4, test: 6 } as const;

/** RFC 5426: every receiver takes 480 bytes; past IPv4's 65,507 a datagram cannot be sent. */
export const MIN_DATAGRAM_BYTES = 480;
export const MAX_DATAGRAM_BYTES = 65_507;
export const DEFAULT_DATAGRAM_BYTES = 2048;

/** PRINTUSASCII, at most 255: anything else in a host name would end the field early. */
export function syslogHostname(name = hostname()): string {
  const printable = name.replace(/[^\x21-\x7e]/g, "-").slice(0, 255);
  return printable || "-";
}

/** RFC 5424 6.3.3: inside a PARAM-VALUE, `"`, `\` and `]` are escaped with a backslash. */
export function escapeParamValue(value: string): string {
  return value.replace(/["\\\]]/g, (char) => `\\${char}`);
}

function structuredData(params: [string, string | number][]): string {
  if (params.length === 0) return "-";
  const body = params.map(([name, value]) => `${name}="${escapeParamValue(String(value))}"`);
  return `[${SD_ID} ${body.join(" ")}]`;
}

function chainParams(record: StreamRecord): [string, string | number][] {
  switch (record.kind) {
    case "audit":
      return [
        ["seq", record.seq],
        ["prevHash", record.prevHash],
        ["hash", record.hash],
      ];
    case "security":
      return [
        ["seq", record.seq],
        ["chained", "false"],
        ["type", record.type],
      ];
    case "gap":
      return [
        ["stream", record.stream],
        ["from", record.from],
        ["to", record.to],
      ];
    case "test":
      return [];
  }
}

function header(record: StreamRecord, host: string, extra: [string, string | number][] = []) {
  const pri = FACILITY * 8 + SEVERITY[record.kind];
  const sd = structuredData([...chainParams(record), ...extra]);
  return `<${pri}>1 ${record.createdAt} ${host} ${APP_NAME} - ${record.kind} ${sd}`;
}

/** One RFC 5424 message: header, structured data, and the record as JSON for MSG. */
export function formatSyslog(record: StreamRecord, host = syslogHostname()): string {
  return `${header(record, host)} ${JSON.stringify(record)}`;
}

/** RFC 6587 3.4.1: `MSG-LEN SP SYSLOG-MSG`, the length in octets. */
export function octetFrame(message: string): Buffer {
  const body = Buffer.from(message, "utf8");
  return Buffer.concat([Buffer.from(`${body.length} `, "ascii"), body]);
}

/** The longest prefix of `text` within `bytes` octets, never splitting a character. */
function utf8Prefix(text: string, bytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= bytes) return text;
  let end = Math.max(0, bytes);
  // Back off continuation bytes (10xxxxxx) to the start of the character they belong to.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

/**
 * One datagram of at most `maxBytes`. Too long, the header and structured data stay whole, gain
 * `truncated` (the JSON's full length in octets), and the JSON is cut on a character boundary.
 */
export function formatDatagram(
  record: StreamRecord,
  maxBytes: number,
  host = syslogHostname(),
): Buffer {
  const whole = formatSyslog(record, host);
  if (Buffer.byteLength(whole, "utf8") <= maxBytes) return Buffer.from(whole, "utf8");
  const json = JSON.stringify(record);
  const head = header(record, host, [["truncated", Buffer.byteLength(json, "utf8")]]);
  const room = maxBytes - Buffer.byteLength(head, "utf8") - 1;
  if (room <= 0) return Buffer.from(head, "utf8");
  return Buffer.from(`${head} ${utf8Prefix(json, room)}`, "utf8");
}
