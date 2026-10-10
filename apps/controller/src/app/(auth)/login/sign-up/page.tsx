import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { selfRegistrationOpen } from "@/src/lib/auth/policy";
import { getAppName } from "@/src/lib/branding/app-name";
import SignUpClient from "@/src/components/auth/SignUpClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signUp");
  return { title: t("metaTitle") };
}

/** Under /login so the proxy lets a signed-out visitor in; Better Auth's sign-up route is public. */
export default async function SignUpPage() {
  if (await auth()) redirect("/");
  // The route is off too (auth/server.ts), so the form could only fail.
  if (!(await selfRegistrationOpen())) redirect("/login");
  return <SignUpClient appName={await getAppName()} />;
}
