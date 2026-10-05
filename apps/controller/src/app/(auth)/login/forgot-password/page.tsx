import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { localUsersDisabled } from "@/src/lib/auth/policy";
import { getAppName } from "@/src/lib/branding/app-name";
import { emailReady } from "@/src/lib/email/config";
import ForgotPasswordForm from "@/src/components/auth/ForgotPasswordForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.passwordReset");
  return { title: t("requestMetaTitle") };
}

/** Under /login so the proxy lets a signed-out visitor in; the API it posts to is its own. */
export default async function ForgotPasswordPage() {
  if (await auth()) redirect("/");
  // Nothing could be sent, and a form that pretends otherwise strands its reader.
  if ((await localUsersDisabled()) || !(await emailReady())) redirect("/login");
  return <ForgotPasswordForm appName={await getAppName()} />;
}
