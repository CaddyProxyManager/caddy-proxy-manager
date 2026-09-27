import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { requiresLegacyPasswordChange } from "@/src/lib/services/legacy-password";
import LegacyPasswordChangeForm from "@/src/components/auth/LegacyPasswordChangeForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.passwordChange");
  return { title: t("metaTitle") };
}

/** Outside the dashboard route group on purpose: the dashboard layout redirects here. */
export default async function PasswordChangePage() {
  const session = await requireUser();

  // Including right after a change, when the hash is argon2id and the gate no longer matches.
  if (!(await requiresLegacyPasswordChange(Number(session.user.id)))) {
    redirect("/");
  }

  return <LegacyPasswordChangeForm />;
}
