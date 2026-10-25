import { redirect } from "next/navigation";
import { editorSectionHref } from "@/src/lib/proxy-hosts/editor-sections";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ revision?: string }>;
};

/** The editor opens on its first section; an old link's hash still names another on arrival. */
export default async function EditRedirect({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { revision } = await searchParams;
  const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
  redirect(`${editorSectionHref(encodeURIComponent(id))}${query}`);
}
