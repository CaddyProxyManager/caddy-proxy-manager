import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  editorSectionFromLink,
  editorSectionHref,
  isEditorSection,
} from "@/src/lib/proxy-hosts/editor-sections";

type PageProps = {
  params: Promise<{ id: string; section: string }>;
  searchParams: Promise<{ revision?: string }>;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("proxyHosts");
  return { title: t("editProxyHost") };
}

/** Names the section the layout's editor shows; the editor itself lives in the layout. */
export default async function ProxyHostEditSectionPage({ params, searchParams }: PageProps) {
  const { id, section } = await params;
  if (isEditorSection(section)) return null;
  // A section since merged into another keeps its old links working.
  const merged = editorSectionFromLink(section);
  if (!merged) notFound();
  const { revision } = await searchParams;
  const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
  redirect(`${editorSectionHref(encodeURIComponent(id), merged)}${query}`);
}
