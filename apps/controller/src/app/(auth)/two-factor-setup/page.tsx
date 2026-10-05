import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { mustEnrollTwoFactor } from "@/src/lib/auth/two-factor/policy";
import { listUserPasskeys } from "@/src/lib/auth/passkeys";
import { passkeyRpId } from "@/src/lib/auth/passkeys/relying-party";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";
import { isDemoAdmin } from "@/src/lib/demo/mode";
import { TwoFactorSetupClient } from "./TwoFactorSetupClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.twoFactorSetup");
  return { title: t("title") };
}

/** Outside the dashboard group on purpose: the proxy redirects here, and nothing else loads. */
export default async function TwoFactorSetupPage() {
  const session = await requireUser();
  // Reached directly by someone the policy doesn't cover, or right after setting one up.
  if (!(await mustEnrollTwoFactor(session))) {
    redirect("/");
  }
  const userId = Number(session.user.id);
  const [passkeys, publicBaseUrl] = await Promise.all([
    listUserPasskeys(userId),
    getPublicBaseUrl(),
  ]);
  return (
    <TwoFactorSetupClient
      passkeys={passkeys}
      rpId={passkeyRpId(publicBaseUrl)}
      locked={isDemoAdmin(userId)}
    />
  );
}
