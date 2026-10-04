"use client";

import { Route } from "lucide-react";
import { useState } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { RewriteConfig } from "@/lib/models/proxy-hosts";
import { useTranslations } from "next-intl";

type Props = { initialData?: RewriteConfig | null };

export function RewriteFields({ initialData }: Props) {
  const t = useTranslations("proxyHosts");
  // Astryx inputs are controlled; htmlName keeps the value in the submitted FormData.
  const [pathPrefix, setPathPrefix] = useState(initialData?.path_prefix ?? "");

  return (
    <TextInput
      startIcon={Route}
      label={t("pathPrefixRewrite")}
      htmlName="rewritePathPrefix"
      value={pathPrefix}
      onChange={setPathPrefix}
      placeholder="/recipes"
      description={t("pathPrefixRewriteHelp")}
    />
  );
}
