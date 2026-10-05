import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { localUsersDisabled } from "@/src/lib/auth/policy";
import { emailReady } from "@/src/lib/email/config";
import ResetPasswordForm from "@/src/components/auth/ResetPasswordForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.passwordReset");
  return { title: t("metaTitle") };
}

/** Open while signed in too: an invitation may be opened in a browser someone else is using. */
export default async function ResetPasswordPage() {
  if (await localUsersDisabled()) redirect("/login");
  return <ResetPasswordForm canRequestAnother={await emailReady()} />;
}
