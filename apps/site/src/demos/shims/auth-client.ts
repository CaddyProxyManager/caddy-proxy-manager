/**
 * The docs site has no `/api/auth/*`, so this never makes a request: every sign-in fails as a wrong
 * password does, except in the setup demo, which has accounts of its own, and no passkey is known.
 * Two-factor setup takes any password and any six digits, since there is no account or
 * authenticator to check them on.
 */
import { currentSimulation } from "../setup-simulation";

const pause = () => new Promise((resolve) => setTimeout(resolve, 700));

/** A made-up key; scanning it adds a harmless entry to an authenticator app. */
const TOTP_URI =
  "otpauth://totp/Caddy%20Proxy%20Manager:avery?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Caddy%20Proxy%20Manager";

function backupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const digits = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  });
}

export const authClient = {
  signIn: {
    async username(input: { username: string; password: string }) {
      const simulation = currentSimulation();
      if (simulation) return simulation.signInUsername(input.username, input.password);
      await pause();
      // No message, so the form uses its own wording.
      return { error: { status: 401 } };
    },
    /** A directory sign-in, which /login uses once a directory is set up: the same wrong password. */
    async ldap(_input: { username: string; password: string; directoryId?: string }) {
      await pause();
      return { error: { status: 401, code: "INVALID_USERNAME_OR_PASSWORD" } };
    },
    async social(input: { provider: string; callbackURL?: string; errorCallbackURL?: string }) {
      const simulation = currentSimulation();
      if (simulation) return simulation.signInSocial(input.callbackURL);
      await pause();
      throw new Error("There is no identity provider behind the documentation site");
    },
    /** Autofill waits quietly, as it does in a browser with no passkey for the site. */
    async passkey(options?: { autoFill?: boolean }) {
      if (options?.autoFill) return new Promise<never>(() => {});
      await pause();
      return { data: null, error: { status: 401, code: "PASSKEY_NOT_FOUND" } };
    },
  },
  twoFactor: {
    async enable(_input: { password: string }) {
      await pause();
      return { data: { totpURI: TOTP_URI, backupCodes: backupCodes() }, error: null };
    },
    async verifyTotp(input: { code: string }) {
      await pause();
      return /^\d{6}$/.test(input.code)
        ? { data: {}, error: null }
        : { data: null, error: { status: 401, code: "INVALID_CODE" } };
    },
    async verifyBackupCode(_input: { code: string }) {
      await pause();
      return { data: null, error: { status: 401, code: "INVALID_BACKUP_CODE" } };
    },
    async generateBackupCodes(_input: { password: string }) {
      await pause();
      return { data: { backupCodes: backupCodes() }, error: null };
    },
    async disable(_input: { password: string }) {
      await pause();
      return { data: {}, error: null };
    },
  },
};
