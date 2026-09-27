import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { mustEnrollTwoFactor } from "@/src/lib/two-factor-policy";
import { TwoFactorSetupClient } from "./TwoFactorSetupClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.twoFactorSetup");
  return { title: t("metaTitle") };
}

/** Outside the dashboard group on purpose: the proxy redirects here, and nothing else loads. */
export default async function TwoFactorSetupPage() {
  const session = await requireUser();
  // Reached directly by someone the policy doesn't cover, or right after turning 2FA on.
  if (!(await mustEnrollTwoFactor(session))) {
    redirect("/");
  }
  return <TwoFactorSetupClient />;
}
