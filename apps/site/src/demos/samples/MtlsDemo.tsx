import { MtlsFields } from "@cpm/controller/src/components/proxy-hosts/protection/MtlsConfig";
import { DemoSurface } from "../DemoSurface";

const CA = {
  id: 1,
  name: "Internal CA",
  certificatePem: "",
  hasPrivateKey: true,
  createdAt: "2026-01-04T09:00:00.000Z",
  updatedAt: "2026-01-04T09:00:00.000Z",
};

/** Two issued certificates and two roles: enough for the ops-only path rule the prose describes. */
export default function MtlsDemo() {
  return (
    <DemoSurface>
      <MtlsFields
        value={{ enabled: true, trusted_role_ids: [1], protected_paths: ["/admin/*"] }}
        caCertificates={[CA]}
        mtlsRoles={[
          {
            id: 1,
            name: "ops",
            description: "Reaches /admin/*",
            certificateCount: 1,
            createdAt: CA.createdAt,
            updatedAt: CA.updatedAt,
          },
          {
            id: 2,
            name: "staff",
            description: null,
            certificateCount: 1,
            createdAt: CA.createdAt,
            updatedAt: CA.updatedAt,
          },
        ]}
        issuedClientCerts={[
          {
            id: 1,
            caCertificateId: 1,
            commonName: "avery@laptop",
            serialNumber: "0A1B2C",
            fingerprintSha256: "",
            certificatePem: "",
            validFrom: "2026-01-04T09:00:00.000Z",
            validTo: "2027-01-04T09:00:00.000Z",
            revokedAt: null,
            createdAt: CA.createdAt,
            updatedAt: CA.updatedAt,
          },
          {
            id: 2,
            caCertificateId: 1,
            commonName: "backup-runner",
            serialNumber: "0A1B2D",
            fingerprintSha256: "",
            certificatePem: "",
            validFrom: "2026-01-04T09:00:00.000Z",
            validTo: "2027-01-04T09:00:00.000Z",
            revokedAt: null,
            createdAt: CA.createdAt,
            updatedAt: CA.updatedAt,
          },
        ]}
      />
    </DemoSurface>
  );
}
