import type { Session } from "../index";
import { getTwoFactorPolicySettings } from "../../settings";

/** Outside the dashboard layout. */
export const TWO_FACTOR_SETUP_PATH = "/two-factor-setup";

/** Password accounts only: with single sign-on, the identity provider decides about 2FA. */
export async function mustEnrollTwoFactor(session: Session | null): Promise<boolean> {
  const user = session?.user;
  // The real role: "View as" narrows user.role, and must not narrow its way past this gate.
  const role = session?.realRole ?? user?.role;
  if (role !== "admin" || !user?.hasPassword || user.twoFactorEnabled) return false;
  return (await getTwoFactorPolicySettings()).requireForAdmins;
}
