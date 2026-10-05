/**
 * The SMTP settings as one object. Imported lazily, like branding/app-name.ts: the registry reads
 * process.env on first load, which a static import would freeze before a test sets it.
 */

import type { SmtpSecurity } from "./security";

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  from: string;
};

/** `off`: switched off. `incomplete`: on, but with no server or no sender to send as. */
export type EmailStatus = "off" | "incomplete" | "ready";

export async function readSmtpConfig(): Promise<{ status: EmailStatus; config: SmtpConfig }> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [enabled, host, port, security, username, password, from] = await Promise.all([
    getSetting(registry.smtpEnabled),
    getSetting(registry.smtpHost),
    getSetting(registry.smtpPort),
    getSetting(registry.smtpSecurity),
    getSetting(registry.smtpUsername),
    getSetting(registry.smtpPassword),
    getSetting(registry.smtpFrom),
  ]);
  const config: SmtpConfig = {
    host,
    port,
    security: security as SmtpSecurity,
    username,
    password,
    from,
  };
  // Unset infers from the host, so SMTP_HOST alone switches it on.
  const on = enabled ?? host !== "";
  if (!on) return { status: "off", config };
  return { status: host && from ? "ready" : "incomplete", config };
}

/** Whether anything that sends mail should offer to. */
export async function emailReady(): Promise<boolean> {
  try {
    return (await readSmtpConfig()).status === "ready";
  } catch {
    return false;
  }
}
