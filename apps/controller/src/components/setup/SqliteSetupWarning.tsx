"use client";

import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";

const INSTALL_GUIDE = "https://caddyproxy.com/start/install/";

/** Not dismissable here: setup is the one moment switching databases costs nothing. */
export function SqliteSetupWarning() {
  const t = useTranslations("setup");
  return (
    <Banner
      status="warning"
      title={t("sqliteWarningTitle")}
      description={
        <Text type="body" size="sm">
          {t.rich("sqliteWarningDescription", {
            link: (chunks) => (
              <Link href={INSTALL_GUIDE} target="_blank">
                {chunks}
              </Link>
            ),
          })}
        </Text>
      }
    />
  );
}
