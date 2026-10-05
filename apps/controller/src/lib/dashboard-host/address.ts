/** Browser-safe: dashboard-host/index.ts reads server config and resolves DNS. Type imports only. */
import type { DashboardHostSettings } from "./index";

/**
 * Only while the host is on. Over HTTP it spells out :80, since the agent reads a portless
 * `http://` as 3000; `insecure` flags that, which an agent refuses for a public address by default.
 */
export function pairingHostFor(
  settings: DashboardHostSettings | null,
): { host: string; insecure: boolean } | null {
  const domain = settings?.domain.trim().toLowerCase() ?? "";
  if (!settings?.enabled || !domain) return null;
  return settings.tls
    ? { host: domain, insecure: false }
    : { host: `http://${domain}:80`, insecure: true };
}
