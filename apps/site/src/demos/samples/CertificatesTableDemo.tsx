import { Badge } from "@astryxdesign/core/Badge";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { DataTable, type Column } from "@cpm/controller/src/components/ui/DataTable";
import { StatTiles } from "@cpm/controller/src/components/ui/StatTiles";
import { StatusChip } from "@cpm/controller/src/components/ui/StatusChip";
import { DemoSurface } from "../DemoSurface";

type Row = {
  id: number;
  domain: string;
  issuer: string;
  challenge: string;
  expires: string;
  status: "active" | "warning" | "error";
};

/**
 * One healthy, one close to expiry, one that has failed - what the page is watched for. Only the
 * imported ones carry a date: ACME certificates are renewed by Caddy on the agent, and their expiry
 * never reaches the controller.
 */
const CERTS: Row[] = [
  {
    id: 1,
    domain: "app.example.com",
    issuer: "Let's Encrypt",
    challenge: "HTTP-01",
    expires: "Renewed by Caddy",
    status: "active",
  },
  {
    id: 2,
    domain: "legacy.example.com",
    issuer: "DigiCert",
    challenge: "Imported PEM",
    expires: "in 9 days",
    status: "warning",
  },
  {
    id: 3,
    domain: "vpn.example.com",
    issuer: "Internal CA",
    challenge: "-",
    expires: "expired",
    status: "error",
  },
];

function CertificatesTableDemoContent() {
  const t = useTranslations("certificates");
  // Only imported certificates have an expiry the controller can count, hence the split.
  const acme = CERTS.filter((c) => c.issuer === "Let's Encrypt").length;
  const imported = CERTS.length - acme;
  const expired = CERTS.filter((c) => c.status === "error").length;

  const columns: Column<Row>[] = [
    {
      id: "domain",
      label: "Domain",
      render: (r) => (
        <Text type="body" size="sm" weight="semibold">
          {r.domain}
        </Text>
      ),
    },
    { id: "issuer", label: "Issuer", render: (r) => <Badge label={r.issuer} /> },
    {
      id: "challenge",
      label: "Challenge",
      render: (r) => (
        <Text type="body" size="sm" color="secondary">
          {r.challenge}
        </Text>
      ),
    },
    {
      id: "expires",
      label: "Expires",
      render: (r) => (
        <Text type="body" size="sm" color="secondary">
          {r.expires}
        </Text>
      ),
    },
    {
      id: "status",
      label: "Status",
      render: (r) => (
        <StatusChip
          status={r.status}
          label={
            r.status === "warning" ? "Expiring soon" : r.status === "error" ? "Expired" : "Valid"
          }
        />
      ),
    },
  ];

  return (
    <VStack gap={4}>
      {/* Desktop only, as ListPageHeader has them: a phone list is for finding a row. */}
      <div className="cpm-desktop-only">
        <StatTiles
          tiles={[
            { id: "acme", label: t("acme"), value: acme, note: t("acmeNote", { count: acme }) },
            {
              id: "imported",
              label: t("imported"),
              value: imported,
              note: t("importedExpiredNote"),
              accent: { label: t("expiredAccent", { count: expired }), variant: "error" },
            },
            { id: "ca", label: t("caMtls"), value: 1, note: t("caNote", { count: 4 }) },
            { id: "roles", label: t("roles"), value: 2, note: t("rolesNote") },
          ]}
        />
      </div>
      <DataTable columns={columns} data={CERTS} keyField="id" emptyMessage="No certificates yet" />
    </VStack>
  );
}

/**
 * The content renders inside DemoSurface rather than around it: the surface is what provides the
 * message catalog, and the content reads from it with useTranslations.
 */
export default function CertificatesTableDemo() {
  return (
    <DemoSurface>
      <CertificatesTableDemoContent />
    </DemoSurface>
  );
}
