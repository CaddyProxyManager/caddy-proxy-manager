/**
 * The overview's server log search: PowerSearch tokens over the rows already loaded, so it needs
 * no query of its own. Every token must match.
 */

import type {
  EnumItem,
  PowerSearchConfig,
  PowerSearchFilter,
} from "@astryxdesign/core/PowerSearch";

export type ServerLogRow =
  | {
      kind: "traffic";
      ts: number;
      status: number;
      method: string;
      host: string;
      uri: string;
      clientIp: string;
      isBlocked: boolean;
    }
  | { kind: "event"; ts: number; summary: string; actor: string | null; entityType: string };

export const SERVER_LOG_TYPES = [
  "requests",
  "errors",
  "serverErrors",
  "clientErrors",
  "blocked",
  "serverEvents",
] as const;
export type ServerLogType = (typeof SERVER_LOG_TYPES)[number];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// Astryx ships these labels in every locale; no catalog entries needed.
const op = (key: string) => ({ key, i18nKey: `@astryx.powersearch.operator.${key}` }) as const;

export type ServerLogSearchLabels = {
  text: string;
  type: string;
  types: Record<ServerLogType, string>;
  time: string;
  status: string;
  host: string;
  method: string;
  clientIp: string;
  user: string;
};

export function serverLogSearchConfig(labels: ServerLogSearchLabels): PowerSearchConfig {
  const types: EnumItem[] = SERVER_LOG_TYPES.map((value) => ({
    value,
    label: labels.types[value],
  }));
  return {
    name: "ServerLog",
    contentSearchFieldKey: "text",
    fields: [
      {
        key: "text",
        label: labels.text,
        defaultOperator: "contains",
        operators: [{ ...op("contains"), value: { type: "string" } }],
      },
      {
        key: "type",
        label: labels.type,
        defaultOperator: "isAnyOf",
        operators: [
          { ...op("isAnyOf"), value: { type: "enum_list", values: types } },
          { ...op("isNoneOf"), value: { type: "enum_list", values: types } },
        ],
      },
      {
        key: "time",
        label: labels.time,
        defaultOperator: "after",
        operators: [
          { ...op("after"), value: { type: "date_absolute" } },
          { ...op("before"), value: { type: "date_absolute" } },
        ],
      },
      {
        key: "status",
        label: labels.status,
        defaultOperator: "equals",
        operators: [
          { ...op("equals"), value: { type: "integer", minValue: 100, maxValue: 599 } },
          { ...op("greaterThanOrEqual"), value: { type: "integer", minValue: 100, maxValue: 599 } },
          { ...op("lessThan"), value: { type: "integer", minValue: 100, maxValue: 600 } },
        ],
      },
      {
        key: "host",
        label: labels.host,
        defaultOperator: "contains",
        operators: [{ ...op("contains"), value: { type: "string" } }],
      },
      {
        key: "method",
        label: labels.method,
        defaultOperator: "isAnyOf",
        operators: [
          {
            ...op("isAnyOf"),
            value: { type: "enum_list", values: METHODS.map((m) => ({ value: m, label: m })) },
          },
        ],
      },
      {
        key: "clientIp",
        label: labels.clientIp,
        defaultOperator: "startsWith",
        operators: [
          { ...op("startsWith"), value: { type: "string" } },
          { ...op("is"), value: { type: "string", isArbitraryStringAllowed: true } },
        ],
      },
      {
        key: "user",
        label: labels.user,
        defaultOperator: "contains",
        operators: [{ ...op("contains"), value: { type: "string" } }],
      },
    ],
  };
}

function typeOf(row: ServerLogRow): ServerLogType[] {
  if (row.kind === "event") return ["serverEvents"];
  const types: ServerLogType[] = ["requests"];
  if (row.status >= 400) types.push("errors");
  if (row.status >= 500) types.push("serverErrors");
  else if (row.status >= 400) types.push("clientErrors");
  if (row.isBlocked) types.push("blocked");
  return types;
}

const has = (haystack: string | null | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());

function matches(row: ServerLogRow, filter: PowerSearchFilter): boolean {
  const { field, operator, value } = filter;
  switch (field) {
    case "text": {
      if (value.type !== "string") return true;
      return row.kind === "traffic"
        ? has(`${row.method} ${row.host}${row.uri} ${row.clientIp}`, value.value)
        : has(`${row.summary} ${row.actor ?? ""} ${row.entityType}`, value.value);
    }
    case "type": {
      if (value.type !== "enum_list") return true;
      const any = typeOf(row).some((type) => value.value.includes(type));
      return operator === "isNoneOf" ? !any : any;
    }
    case "time": {
      if (value.type !== "date_absolute") return true;
      return operator === "before" ? row.ts < value.unixSeconds : row.ts >= value.unixSeconds;
    }
    case "status": {
      // A server event has no status, so a status token is about requests only.
      if (row.kind !== "traffic" || value.type !== "integer") return false;
      if (operator === "greaterThanOrEqual") return row.status >= value.value;
      if (operator === "lessThan") return row.status < value.value;
      return row.status === value.value;
    }
    case "host":
      return row.kind === "traffic" && value.type === "string" && has(row.host, value.value);
    case "method":
      return (
        row.kind === "traffic" && value.type === "enum_list" && value.value.includes(row.method)
      );
    case "clientIp": {
      if (row.kind !== "traffic" || value.type !== "string") return false;
      const ip = row.clientIp.toLowerCase();
      const wanted = value.value.trim().toLowerCase();
      return operator === "is" ? ip === wanted : ip.startsWith(wanted);
    }
    case "user":
      return row.kind === "event" && value.type === "string" && has(row.actor, value.value);
    default:
      return true;
  }
}

export function filterServerLog<T extends ServerLogRow>(
  rows: readonly T[],
  filters: ReadonlyArray<PowerSearchFilter>,
): T[] {
  return filters.length === 0
    ? [...rows]
    : rows.filter((row) => filters.every((filter) => matches(row, filter)));
}
