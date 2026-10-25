import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  l4EditorSectionFromLink,
  l4EditorSectionHref,
  isL4EditorSection,
} from "@/src/lib/l4/editor-sections";

type PageProps = {
  params: Promise<{ id: string; section: string }>;
  searchParams: Promise<{ revision?: string }>;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("l4ProxyHosts");
  return { title: t("editL4ProxyHost") };
}

/** Names the section the layout's editor shows; the editor itself lives in the layout. */
export default async function L4ProxyHostEditSectionPage({ params, searchParams }: PageProps) {
  const { id, section } = await params;
  if (isL4EditorSection(section)) return null;
  // A section since merged into another keeps its old links working.
  const merged = l4EditorSectionFromLink(section);
  if (!merged) notFound();
  const { revision } = await searchParams;
  const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
  redirect(`${l4EditorSectionHref(encodeURIComponent(id), merged)}${query}`);
}
