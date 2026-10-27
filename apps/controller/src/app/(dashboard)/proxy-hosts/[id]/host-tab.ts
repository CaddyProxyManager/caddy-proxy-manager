import { notFound } from "next/navigation";
import { getProxyHost, resolveProxyHostId } from "@/src/lib/models/proxy-hosts";
import { loadProxyHostHeader } from "@/src/lib/proxy-hosts/header";
import { hostTrafficNames } from "@/src/lib/proxy-hosts/traffic-status";
import { can, canManage, canView, requireReach } from "@/src/lib/users/permissions";

/**
 * The host's Analytics or Logs tab: whoever may see the host and holds the page's own permission.
 * A host with only wildcard domains has no names to lock the page to, so it has neither tab.
 */
export async function loadHostTab(raw: string, capability: "analytics:read" | "logs:read") {
  const id = await resolveProxyHostId(raw);
  if (id === null) notFound();
  const access = await requireReach("hosts:read");
  if (!canView(access, "proxyHost", id) || !can(access, capability)) notFound();
  const host = await getProxyHost(id);
  if (!host) notFound();
  const names = hostTrafficNames(host.domains);
  if (names.length === 0) notFound();
  return {
    host,
    names,
    header: await loadProxyHostHeader(host, access),
    manages: canManage(access, "proxyHost", id),
  };
}
