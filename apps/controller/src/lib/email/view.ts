/** The Email settings page's data; of the password, only whether one is stored. */

import type { SmtpSecurity } from "./security";
import { getCertificateAlertState } from "./certificate-alerts";
import { type EmailStatus, readSmtpConfig } from "./config";

export type EmailSettingsView = {
  status: EmailStatus;
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  hasPassword: boolean;
  from: string;
  alertRecipients: string;
  alertDays: number;
  alertsCheckedAt: string | null;
  alertsError: string | null;
  notifications: {
    lastSentAt: string | null;
    /** English, as the SMTP server said it. */
    lastError: string | null;
    lastErrorAt: string | null;
    lastErrorCode: "noRecipients" | null;
    pending: number;
    /** Upstream errors are read from the access log, which Caddy writes only while this holds. */
    accessLogOn: boolean;
    upstreamErrorsOn: boolean;
  };
};

export async function emailSettingsView(): Promise<EmailSettingsView> {
  const [registry, { getSetting }, { getNotificationStatus }, stored] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
    import("../notifications"),
    import("../settings"),
  ]);
  const [
    { status, config },
    alertRecipients,
    alertDays,
    alerts,
    notifications,
    logging,
    crowdsec,
    upstreamErrorsOn,
  ] = await Promise.all([
    readSmtpConfig(),
    getSetting(registry.emailAlertRecipients),
    getSetting(registry.certificateExpiryAlertDays),
    getCertificateAlertState(),
    getNotificationStatus(),
    stored.getLoggingSettings(),
    stored.getCrowdSecSettings(),
    getSetting(registry.notifyUpstreamErrors),
  ]);
  return {
    status,
    enabled: status !== "off",
    host: config.host,
    port: config.port,
    security: config.security,
    username: config.username,
    hasPassword: config.password.length > 0,
    from: config.from,
    alertRecipients,
    alertDays,
    alertsCheckedAt: alerts.checkedAt,
    alertsError: alerts.error,
    notifications: {
      ...notifications,
      // As lib/caddy.ts decides it: managed CrowdSec forces the log on, in JSON.
      accessLogOn:
        (crowdsec.enabled && crowdsec.mode === "managed") ||
        (logging?.enabled === true && (logging.format ?? "json") === "json"),
      upstreamErrorsOn,
    },
  };
}
