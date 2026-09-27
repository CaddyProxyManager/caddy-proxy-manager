/** Client-safe on purpose: the Settings form renders the choices the registry validates against. */
export const SMTP_SECURITY_MODES = ["starttls", "tls", "none"] as const;

export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];
