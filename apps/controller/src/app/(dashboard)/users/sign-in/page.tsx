import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getAppName } from "@/src/lib/branding/app-name";
import { getSignInOverview } from "@/src/lib/users/sign-in-overview";
import { SignInOverviewClient } from "./SignInOverviewClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signInOverview");
  return { title: t("title") };
}

export default async function SignInOverviewPage() {
  await requireCan("users:read");
  const [overview, appName] = await Promise.all([getSignInOverview(), getAppName()]);
  return <SignInOverviewClient overview={overview} appName={appName} />;
}
