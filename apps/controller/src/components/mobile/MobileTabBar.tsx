"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { Text } from "@astryxdesign/core/Text";
import { canSee, DESTINATIONS, type DestinationId } from "@/src/lib/nav/destinations";
import { ACCENTS } from "@/src/components/ui/accent";
import { DESTINATION_HUES, DESTINATION_ICONS } from "./nav-icons";

/** Two taps on More within this window go to the full More page instead of the drawer. */
const DOUBLE_TAP_MS = 350;

type TabSpec = {
  key: string;
  /** Supplies visibility and href. */
  destination: DestinationId;
  labelKey: "overview" | "hosts" | "agents" | "analytics";
  /** Every path this tab owns - Hosts owns both host pages. */
  owns: string[];
};

const TABS: TabSpec[] = [
  { key: "overview", destination: "overview", labelKey: "overview", owns: ["/"] },
  {
    key: "hosts",
    destination: "proxy-hosts",
    labelKey: "hosts",
    owns: ["/proxy-hosts", "/l4-proxy-hosts"],
  },
  { key: "agents", destination: "agents", labelKey: "agents", owns: ["/agents"] },
  { key: "analytics", destination: "analytics", labelKey: "analytics", owns: ["/analytics"] },
];

/** Ellipsizes rather than overlapping a neighbour; the tab's accessible name keeps the whole label. */
function TabLabel({ isActive, children }: { isActive: boolean; children: string }) {
  return (
    <Text
      size="sm"
      color="inherit"
      weight={isActive ? "semibold" : "medium"}
      justify="center"
      maxLines={1}
      hasTruncateTooltip={false}
      className="cpm-tab-label"
    >
      {children}
    </Text>
  );
}

function owns(pathname: string, path: string): boolean {
  return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
}

/** Replaces the hamburger drawer rather than adding a second persistent nav bar. */
export function MobileTabBar({
  role,
  isMoreOpen,
  onToggleMore,
  onCloseMore,
  moreButtonRef,
}: {
  role: string | undefined;
  isMoreOpen: boolean;
  onToggleMore: () => void;
  onCloseMore: () => void;
  moreButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const router = useRouter();
  const lastMoreTap = useRef(0);

  const tabs = TABS.filter((tab) => {
    const destination = DESTINATIONS.find((d) => d.id === tab.destination);
    return destination !== undefined && canSee(destination, role);
  });
  const tabOwnsPath = tabs.some((tab) => tab.owns.some((path) => owns(pathname, path)));
  // More is active whenever no named tab owns the path.
  const isMoreActive = isMoreOpen || !tabOwnsPath;

  const handleMore = () => {
    const now = Date.now();
    if (now - lastMoreTap.current < DOUBLE_TAP_MS) {
      lastMoreTap.current = 0;
      onCloseMore();
      router.push("/more");
      return;
    }
    lastMoreTap.current = now;
    onToggleMore();
  };

  return (
    <nav className="cpm-tabbar" aria-label={t("mobileNavLabel")}>
      {tabs.map((tab) => {
        const destination = DESTINATIONS.find((d) => d.id === tab.destination)!;
        const Icon: LucideIcon = DESTINATION_ICONS[tab.destination];
        const isActive = !isMoreOpen && tab.owns.some((path) => owns(pathname, path));
        return (
          <Link
            key={tab.key}
            href={destination.href}
            className="cpm-tab"
            data-active={isActive || undefined}
            aria-current={isActive ? "page" : undefined}
            onClick={onCloseMore}
          >
            <span className="cpm-tab-bar-mark" aria-hidden="true" />
            <Icon
              size={22}
              strokeWidth={1.75}
              aria-hidden="true"
              className={ACCENTS[DESTINATION_HUES[tab.destination]].text}
            />
            <TabLabel isActive={isActive}>{t(tab.labelKey)}</TabLabel>
          </Link>
        );
      })}
      <button
        ref={moreButtonRef}
        type="button"
        className="cpm-tab"
        data-active={isMoreActive || undefined}
        aria-expanded={isMoreOpen}
        aria-haspopup="dialog"
        onClick={handleMore}
      >
        <span className="cpm-tab-bar-mark" aria-hidden="true" />
        <Ellipsis size={22} strokeWidth={1.75} aria-hidden="true" />
        <TabLabel isActive={isMoreActive}>{t("more.title")}</TabLabel>
      </button>
    </nav>
  );
}
