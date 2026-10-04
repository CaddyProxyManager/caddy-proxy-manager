/** The Email settings page's data; of the password, only whether one is stored. */

import type { UnavailableReason } from "../notifications/availability";
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
    /** Notification fields greyed out because their event cannot happen, with why. */
    unavailable: Record<string, UnavailableReason>;
  };
};

export async function emailSettingsView(): Promise<EmailSettingsView> {
  const [registry, { getSetting }, { getNotificationStatus }, { unavailableNotificationSettings }] =
    await Promise.all([
      import("../settings/registry"),
      import("../settings/resolve"),
      import("../notifications"),
      import("../notifications/availability"),
    ]);
  const [{ status, config }, alertRecipients, alertDays, alerts, notifications, unavailable] =
    await Promise.all([
      readSmtpConfig(),
      getSetting(registry.emailAlertRecipients),
      getSetting(registry.certificateExpiryAlertDays),
      getCertificateAlertState(),
      getNotificationStatus(),
      unavailableNotificationSettings(),
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
    notifications: { ...notifications, unavailable },
  };
}
