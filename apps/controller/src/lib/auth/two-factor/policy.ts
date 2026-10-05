import type { Session } from "../index";
import { getTwoFactorPolicySettings } from "../../settings";
import { type MfaStanding, coveredByMfaPolicy, mfaStanding, readMfaPolicy } from "./mfa-policy";
import { accountMfaFacts } from "./facts";

export { TWO_FACTOR_SETUP_PATH } from "./error";

/** Cheapest checks first: this runs for every request the proxy gates. */
export async function mfaStandingFor(session: Session | null): Promise<MfaStanding> {
  const user = session?.user;
  if (!user?.hasPassword) return { status: "exempt" };
  if (user.twoFactorEnabled) return { status: "satisfied" };
  const policy = readMfaPolicy(await getTwoFactorPolicySettings());
  // The real role: "View as" narrows user.role, and must not narrow its way past this gate.
  const role = session?.realRole ?? user.role;
  const subject = {
    role,
    hasPassword: true,
    twoFactorEnabled: false,
    passkeyCount: 0,
    createdAt: null,
  };
  if (!coveredByMfaPolicy(policy, subject)) return { status: "exempt" };
  const facts = await accountMfaFacts(Number(user.id));
  return mfaStanding(policy, { ...subject, ...facts });
}

/** For an account without a session: a token's owner, or a portal sign-in. */
export async function mfaStandingForAccount(account: {
  id: number;
  role: string;
  hasPassword: boolean;
  twoFactorEnabled: boolean;
}): Promise<MfaStanding> {
  if (!account.hasPassword) return { status: "exempt" };
  if (account.twoFactorEnabled) return { status: "satisfied" };
  const policy = readMfaPolicy(await getTwoFactorPolicySettings());
  const subject = {
    role: account.role,
    hasPassword: true,
    twoFactorEnabled: false,
    passkeyCount: 0,
    createdAt: null,
  };
  if (!coveredByMfaPolicy(policy, subject)) return { status: "exempt" };
  return mfaStanding(policy, { ...subject, ...(await accountMfaFacts(account.id)) });
}

/** Past its grace period: the proxy sends this session to TWO_FACTOR_SETUP_PATH. */
export async function mustEnrollTwoFactor(session: Session | null): Promise<boolean> {
  return (await mfaStandingFor(session)).status === "required";
}
