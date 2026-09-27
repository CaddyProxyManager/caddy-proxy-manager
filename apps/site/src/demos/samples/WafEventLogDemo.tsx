import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Text } from "@astryxdesign/core/Text";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { useTranslations } from "next-intl";
import { DataTable, type Column } from "@cpm/controller/src/components/ui/DataTable";
import {
  UrlPowerSearch,
  type UrlSearchField,
} from "@cpm/controller/src/components/ui/UrlPowerSearch";
import { Timestamp } from "@cpm/controller/src/components/ui/Timestamp";
import { DemoSurface } from "../DemoSurface";
import { useSearchParams } from "../shims/next-navigation";

type Event = {
  id: number;
  ts: number;
  blocked: boolean;
  severity: "CRITICAL" | "WARNING" | "NOTICE";
  host: string;
  clientIp: string;
  countryCode: string;
  method: string;
  uri: string;
  ruleId: number;
  ruleMessage: string;
  matchedData: string;
};

const titleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();

const SEVERITY_VARIANTS = {
  CRITICAL: "error",
  WARNING: "warning",
  NOTICE: "info",
} as const;

/** Includes one false positive (HTML posted in a form) for the prose's suppression flow. */
const EVENTS: Event[] = [
  {
    id: 1,
    ts: Date.UTC(2026, 1, 11, 9, 42, 7) / 1000,
    blocked: true,
    severity: "CRITICAL",
    host: "app.example.com",
    clientIp: "45.147.230.14",
    countryCode: "NL",
    method: "POST",
    uri: "/login",
    ruleId: 942100,
    ruleMessage: "SQL Injection Attack Detected via libinjection",
    matchedData: "username=' OR 1=1 -- ",
  },
  {
    id: 2,
    ts: Date.UTC(2026, 1, 11, 9, 38, 51) / 1000,
    blocked: true,
    severity: "CRITICAL",
    host: "app.example.com",
    clientIp: "45.147.230.14",
    countryCode: "NL",
    method: "GET",
    uri: "/search?q=%3Cscript%3E",
    ruleId: 941100,
    ruleMessage: "XSS Attack Detected via libinjection",
    matchedData: "q=<script>alert(1)</script>",
  },
  {
    id: 3,
    ts: Date.UTC(2026, 1, 11, 8, 12, 3) / 1000,
    blocked: true,
    severity: "WARNING",
    host: "grafana.example.com",
    clientIp: "185.220.101.77",
    countryCode: "DE",
    method: "GET",
    uri: "/.env",
    ruleId: 930120,
    ruleMessage: "OS File Access Attempt",
    matchedData: "REQUEST_FILENAME: /.env",
  },
  {
    id: 4,
    ts: Date.UTC(2026, 1, 11, 8, 11, 58) / 1000,
    blocked: true,
    severity: "WARNING",
    host: "grafana.example.com",
    clientIp: "185.220.101.77",
    countryCode: "DE",
    method: "GET",
    uri: "/wp-admin/setup-config.php",
    ruleId: 930130,
    ruleMessage: "Restricted File Access Attempt",
    matchedData: "REQUEST_FILENAME: /wp-admin/setup-config.php",
  },
  {
    id: 5,
    ts: Date.UTC(2026, 1, 11, 7, 55, 20) / 1000,
    blocked: false,
    severity: "NOTICE",
    host: "wiki.example.com",
    clientIp: "10.0.4.18",
    countryCode: "-",
    method: "POST",
    uri: "/api/pages/42",
    ruleId: 941160,
    ruleMessage: "NoScript XSS InjectionChecker: HTML Injection",
    matchedData: "body: <p>Release notes for <b>3.0</b></p>",
  },
  {
    id: 6,
    ts: Date.UTC(2026, 1, 11, 6, 30, 44) / 1000,
    blocked: true,
    severity: "CRITICAL",
    host: "app.example.com",
    clientIp: "103.152.220.9",
    countryCode: "SG",
    method: "POST",
    uri: "/api/import",
    ruleId: 932130,
    ruleMessage: "Remote Command Execution: Unix Shell Expression Found",
    matchedData: "file=$(cat /etc/passwd)",
  },
  {
    id: 7,
    ts: Date.UTC(2026, 1, 11, 5, 3, 12) / 1000,
    blocked: false,
    severity: "NOTICE",
    host: "wiki.example.com",
    clientIp: "10.0.4.18",
    countryCode: "-",
    method: "POST",
    uri: "/api/pages/17",
    ruleId: 941160,
    ruleMessage: "NoScript XSS InjectionChecker: HTML Injection",
    matchedData: "body: <ul><li>Fixed the importer</li></ul>",
  },
];

type Stats = {
  total: number;
  blocked: number;
  critical: number;
  uniqueHosts: number;
  ruleIdsTriggered: number;
};

/** Counted off the rows above. */
const STATS: Stats = {
  total: EVENTS.length,
  blocked: EVENTS.filter((e) => e.blocked).length,
  critical: EVENTS.filter((e) => e.severity === "CRITICAL").length,
  uniqueHosts: new Set(EVENTS.map((e) => e.host)).size,
  ruleIdsTriggered: new Set(EVENTS.map((e) => e.ruleId)).size,
};

function StatsBar({ stats }: { stats: Stats }) {
  const t = useTranslations("waf");
  const items = [
    { label: t("statTotalEvents"), value: stats.total, color: "primary" as const },
    { label: t("blocked"), value: stats.blocked, color: "accent" as const },
    { label: t("statCritical"), value: stats.critical, color: "accent" as const },
    { label: t("statUniqueHosts"), value: stats.uniqueHosts, color: "accent" as const },
    { label: t("statRuleIdsTriggered"), value: stats.ruleIdsTriggered, color: "accent" as const },
  ];

  return (
    <Grid columns={{ minWidth: 120, max: 5 }} gap={3}>
      {items.map(({ label, value, color }) => (
        <Card key={label} padding={3}>
          <VStack gap={0}>
            <Text type="display-3" color={color} hasTabularNumbers>
              {value}
            </Text>
            <Text type="body" size="xsm" weight="medium" color="secondary">
              {label}
            </Text>
          </VStack>
        </Card>
      ))}
    </Grid>
  );
}

/** The tiles folded into one card on a phone. */
function WafStatusCard({ stats }: { stats: Stats }) {
  const t = useTranslations("waf");
  const rest = [
    { label: t("statTotalEvents"), value: stats.total },
    { label: t("statCritical"), value: stats.critical },
    { label: t("statUniqueHosts"), value: stats.uniqueHosts },
    { label: t("statRuleIdsTriggered"), value: stats.ruleIdsTriggered },
  ];

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <Text type="body" weight="semibold">
            {t("firewall")}
          </Text>
          <Badge variant="success" label={t("enabled")} />
        </HStack>
        <VStack gap={0}>
          <Text type="display-3" color="accent" hasTabularNumbers>
            {stats.blocked}
          </Text>
          <Text type="body" size="xsm" weight="medium" color="secondary">
            {t("blocked")}
          </Text>
        </VStack>
        <Grid columns={{ minWidth: 120, max: 2 }} gap={3}>
          {rest.map(({ label, value }) => (
            <VStack key={label} gap={0}>
              <Text type="body" weight="semibold" hasTabularNumbers>
                {value}
              </Text>
              <Text type="body" size="xsm" color="secondary">
                {label}
              </Text>
            </VStack>
          ))}
        </Grid>
      </VStack>
    </Card>
  );
}

/** Beside the list, not over it, so reading the next event does not mean closing this one. */
function Detail({ event, onClose }: { event: Event; onClose: () => void }) {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between">
          <HStack gap={2} vAlign="center">
            <Text type="label" weight="bold">
              WAF Event
            </Text>
            {event.blocked ? (
              <Badge variant="error" label="Blocked" />
            ) : (
              <Badge variant="warning" label="Detected" />
            )}
          </HStack>
          <Button variant="ghost" size="sm" label="Close" onClick={onClose} />
        </HStack>

        <VStack gap={0}>
          <Text type="label" size="3xs" weight="bold" color="secondary">
            Rule message
          </Text>
          <Text type="body" size="sm">
            {event.ruleMessage}
          </Text>
        </VStack>

        <VStack gap={0}>
          <Text type="label" size="3xs" weight="bold" color="secondary">
            Matched data
          </Text>
          <Text type="code" size="xsm">
            {event.matchedData}
          </Text>
        </VStack>

        <Divider />

        <HStack gap={2} wrap="wrap">
          <Button variant="secondary" size="sm" label={`Suppress ${event.ruleId} everywhere`} />
          <Button variant="secondary" size="sm" label={`Suppress on ${event.host}`} />
        </HStack>
      </VStack>
    </Card>
  );
}

function WafEventLogDemoContent() {
  const t = useTranslations("waf");
  const params = useSearchParams();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Phone-only, as on the page: search waits behind its icon, and an event replaces the list.
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // The field is only hidden, never unmounted, so autofocus would never fire.
  useEffect(() => {
    if (searchOpen) searchWrapRef.current?.querySelector("input")?.focus();
  }, [searchOpen]);

  // The page server's parameters, answered off the rows above.
  const query = params.toString();
  const rows = useMemo(() => {
    const filter = new URLSearchParams(query);
    const needle = filter.get("search")?.trim().toLowerCase();
    const host = filter.get("host");
    const ip = filter.get("ip");
    const rule = filter.get("rule");
    const action = filter.get("action");
    const severity = filter.get("severity");
    return EVENTS.filter(
      (event) =>
        (!needle ||
          `${event.host} ${event.clientIp} ${event.uri} ${event.ruleMessage}`
            .toLowerCase()
            .includes(needle)) &&
        (!host || event.host === host) &&
        (!ip || event.clientIp === ip) &&
        (!rule || String(event.ruleId) === rule) &&
        (!action || event.blocked === (action === "blocked")) &&
        (!severity || event.severity === severity.toUpperCase()),
    );
  }, [query]);
  const filtered = rows.length !== EVENTS.length;
  const filterFields: UrlSearchField[] = [
    { param: "search", label: t("filterText"), kind: "text" },
    {
      param: "host",
      label: t("host"),
      kind: "enum",
      values: [...new Set(EVENTS.map((event) => event.host))]
        .sort()
        .map((host) => ({ value: host, label: host })),
    },
    { param: "ip", label: t("clientIp"), kind: "exact" },
    { param: "rule", label: t("ruleId"), kind: "exact" },
    {
      param: "action",
      label: t("action"),
      kind: "enum",
      values: [
        { value: "blocked", label: t("blocked") },
        { value: "detected", label: t("detected") },
      ],
    },
    {
      param: "severity",
      label: t("severity"),
      kind: "enum",
      values: Object.keys(SEVERITY_VARIANTS).map((value) => ({ value, label: titleCase(value) })),
    },
  ];
  const selected = rows.find((event) => event.id === selectedId) ?? null;

  const columns: Column<Event>[] = [
    {
      id: "ts",
      label: t("time"),
      width: 170,
      render: (r) => (
        <Text type="code" size="xsm" color="secondary">
          <Timestamp value={r.ts * 1000} />
        </Text>
      ),
    },
    {
      id: "blocked",
      label: "Action",
      width: 110,
      render: (r) =>
        r.blocked ? (
          <Badge variant="error" label="Blocked" />
        ) : (
          <Badge variant="warning" label="Detected" />
        ),
    },
    {
      id: "severity",
      label: "Severity",
      width: 100,
      render: (r) => (
        <Badge variant={SEVERITY_VARIANTS[r.severity]} label={titleCase(r.severity)} />
      ),
    },
    {
      id: "host",
      label: "Host",
      width: 150,
      render: (r) => (
        <Text type="code" size="xsm" maxLines={1}>
          {r.host}
        </Text>
      ),
    },
    {
      id: "clientIp",
      label: "Client IP",
      width: 150,
      render: (r) => (
        <HStack gap={1} vAlign="center">
          <Text type="code" size="xsm">
            {r.clientIp}
          </Text>
          {r.countryCode !== "-" && <Badge label={r.countryCode} />}
        </HStack>
      ),
    },
    {
      id: "method",
      label: "Request",
      width: 220,
      render: (r) => (
        <HStack gap={2} vAlign="center">
          <Text type="code" size="xsm" weight="bold" color="accent">
            {r.method}
          </Text>
          <Text type="code" size="xsm" color="secondary" maxLines={1}>
            {r.uri}
          </Text>
        </HStack>
      ),
    },
    {
      id: "ruleId",
      label: "Rule ID",
      width: 80,
      render: (r) => (
        <Text type="code" size="xsm" color="secondary">
          {r.ruleId}
        </Text>
      ),
    },
  ];

  // The list it replaces may have been scrolled well down.
  useEffect(() => {
    if (isNarrow && selected) detailRef.current?.scrollIntoView({ block: "start" });
  }, [isNarrow, selected]);

  return (
    <VStack gap={4}>
      {/* On a phone the field hides behind the header's search icon. */}
      <HStack justify="end" className="cpm-mobile-flex">
        <IconButton
          variant="ghost"
          label={t("searchWafEvents")}
          icon={<Search />}
          onClick={() => setSearchOpen((open) => !open)}
        />
      </HStack>

      <div className="cpm-desktop-only">
        <StatsBar stats={STATS} />
      </div>
      <div className="cpm-mobile-only">
        <WafStatusCard stats={STATS} />
      </div>

      {/* On a phone, also shown while a search is applied so the filter never hides. */}
      <div
        ref={searchWrapRef}
        className={searchOpen || filtered ? undefined : "cpm-desktop-only"}
        style={{ maxWidth: 640 }}
      >
        <UrlPowerSearch
          name="WafEvents"
          fields={filterFields}
          width="100%"
          placeholder={t("eventsSearchPlaceholder")}
          label={t("searchWafEvents")}
          resultCount={rows.length}
        />
      </div>

      {isNarrow && selected ? (
        <VStack gap={3} ref={detailRef}>
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft />}
              label={t("backToEvents")}
              onClick={() => setSelectedId(null)}
            />
          </div>
          <Detail event={selected} onClose={() => setSelectedId(null)} />
        </VStack>
      ) : (
        /* Side by side when there is room, the panel under the table when not. */
        <HStack gap={4} vAlign="start" wrap="wrap">
          <div style={{ flexGrow: 1, flexBasis: 520, minWidth: 0 }}>
            <DataTable
              columns={columns}
              data={rows}
              keyField="id"
              emptyMessage="No events match that search"
              onRowClick={(row) => setSelectedId((cur) => (cur === row.id ? null : row.id))}
              rowStatus={(row) =>
                row.id === selectedId ? { color: "accent", label: "Selected" } : null
              }
            />
          </div>
          {selected && (
            <div style={{ flexGrow: 1, flexBasis: 320, maxWidth: 460, minWidth: 0 }}>
              <Detail event={selected} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </HStack>
      )}
    </VStack>
  );
}

/** Inside DemoSurface, which provides the message catalog useTranslations reads. */
export default function WafEventLogDemo() {
  return (
    <DemoSurface>
      <WafEventLogDemoContent />
    </DemoSurface>
  );
}
