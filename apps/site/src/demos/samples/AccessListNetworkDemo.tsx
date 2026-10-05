import { useState } from "react";
import { NetworkTab } from "@cpm/controller/src/app/(dashboard)/access-lists/NetworkTab";
import type { AccessList } from "@cpm/controller/src/lib/models/access-lists";
import { DemoSurface } from "../DemoSurface";
import { rememberAccessList } from "../shims/access-list-actions";

/**
 * An office allowlist with one address carved out of it - order is what makes the deny win - a
 * dynamic-DNS name for someone working from home, and a country for a team abroad until a date.
 */
const OFFICE: AccessList = {
  id: 1,
  name: "Office",
  description: "The office network, the VPN, and home",
  entries: [],
  ipRules: [
    { action: "deny", cidr: "192.168.10.66/32", hostname: null, note: "Guest kiosk" },
    { action: "allow", cidr: "192.168.10.0/24", hostname: null, note: "Office LAN" },
    { action: "allow", cidr: "fd7a:115c:a1e0::/48", hostname: null, note: "Tailnet" },
    {
      action: "allow",
      cidr: null,
      hostname: "home.example.net",
      note: "Dynamic DNS at home",
      resolved: {
        ranges: ["2001:db8:4f2:1a00::/64", "203.0.113.24/32"],
        resolvedAt: "2026-09-01T09:00:00Z",
        lastError: null,
        lastErrorAt: null,
      },
    },
    {
      action: "allow",
      cidr: null,
      hostname: null,
      country: "PT",
      note: "Lisbon offsite",
      expiresAt: "2026-12-31T18:00:00Z",
    },
  ],
  ipDefault: "deny",
  satisfy: "all",
  passAuth: false,
  denyResponse: { status: 403, body: "This site is for the office network.", redirectUrl: null },
  failClosed: false,
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-01T09:00:00Z",
};

rememberAccessList(OFFICE);

/** The real tab; saving goes to the shim, which answers with the list as a server would. */
export default function AccessListNetworkDemo() {
  const [list, setList] = useState(OFFICE);
  return (
    <DemoSurface>
      <NetworkTab list={list} onListUpdated={setList} />
    </DemoSurface>
  );
}
