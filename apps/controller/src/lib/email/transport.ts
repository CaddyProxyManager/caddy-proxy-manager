import nodemailer from "nodemailer";
import { getAppName } from "../branding/app-name";
import { domainError } from "../errors/domain-error";
import { readSmtpConfig, type SmtpConfig } from "./config";

export type EmailMessage = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
};

/** An object, not a string: nodemailer encodes the name, so a comma in it cannot add a recipient. */
export type OutgoingEmail = EmailMessage & { from: { name: string; address: string } };

type Deliver = (config: SmtpConfig, message: OutgoingEmail) => Promise<void>;

async function deliverOverSmtp(config: SmtpConfig, message: OutgoingEmail) {
  // outbound: smtp
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    // Without requireTLS a server that drops STARTTLS from its EHLO gets the password in clear.
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    // Nodemailer's defaults are minutes; a request waiting on a dead relay should not be.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail(message);
  } finally {
    transport.close();
  }
}

let deliver: Deliver = deliverOverSmtp;

/** Test seam: capture messages instead of opening a connection. Null restores SMTP. */
export function setEmailDeliveryForTests(replacement: Deliver | null): void {
  deliver = replacement ?? deliverOverSmtp;
}

/** Throws `emailNotConfigured` unless email is on and complete, `emailSendFailed` on refusal. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const { status, config } = await readSmtpConfig();
  if (status !== "ready") throw domainError("emailNotConfigured");

  const from = { name: await getAppName(), address: config.from };
  try {
    await deliver(config, { ...message, from });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw domainError("emailSendFailed", { detail });
  }
}
