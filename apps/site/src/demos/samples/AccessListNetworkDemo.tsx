import { useState } from "react";
import { NetworkTab } from "@cpm/controller/src/app/(dashboard)/access-lists/NetworkTab";
import type { AccessList } from "@cpm/controller/src/lib/models/access-lists";
import { DemoSurface } from "../DemoSurface";
import { rememberAccessList } from "../shims/access-list-actions";

/** An office allowlist with one address carved out of it: order is what makes the deny win. */
const OFFICE: AccessList = {
  id: 1,
  name: "Office",
  description: "The office network, and the VPN",
  entries: [],
  ipRules: [
    { action: "deny", cidr: "192.168.10.66", note: "Guest kiosk" },
    { action: "allow", cidr: "192.168.10.0/24", note: "Office LAN" },
    { action: "allow", cidr: "fd7a:115c:a1e0::/48", note: "Tailnet" },
  ],
  ipDefault: "deny",
  satisfy: "all",
  passAuth: false,
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
