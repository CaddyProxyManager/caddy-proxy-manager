import { requireCan } from "@/src/lib/users/permissions";
import ApiDocsClient from "./ApiDocsClient";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("apiDocs") };
}

export default async function ApiDocsPage() {
  await requireCan("settings:read");

  return <ApiDocsClient />;
}
