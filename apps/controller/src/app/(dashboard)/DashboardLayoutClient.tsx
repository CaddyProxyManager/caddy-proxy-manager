"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import { stopViewAsAction } from "./view-as/actions";
import { Button } from "@astryxdesign/core/Button";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "@astryxdesign/core";
import { LogOut, Sun, Moon } from "lucide-react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import SettingsSideNav from "./settings/SettingsSideNav";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { UserAvatar } from "@/src/components/UserAvatar";
import {
  GlobalCommandPaletteProvider,
  PaletteSearchButton,
} from "@/src/components/command-palette/GlobalCommandPalette";
import { LocaleSwitcher } from "@/src/components/locale/LocaleSwitcher";
import { MobileTabBar } from "@/src/components/mobile/MobileTabBar";
import { MoreDrawer } from "@/src/components/mobile/MoreDrawer";
import { DESTINATION_HUES, DESTINATION_ICONS } from "@/src/components/mobile/nav-icons";
import { ACCENTS } from "@/src/components/ui/accent";
import { useThemeMode } from "@/src/components/theme/ThemeModeProvider";
import { formatAppVersion } from "@/src/lib/app-version";
import {
  SQLITE_NOTICE_COOKIE,
  SQLITE_NOTICE_DISMISS_SECONDS,
} from "@/src/lib/sqlite-notice-cookie";
import type { ResolvedAvatar } from "@/src/lib/avatar";
import {
  type Destination,
  type DestinationId,
  moreDestinations,
  RAIL_GROUPS,
  type RailGroup,
  resolveDrawer,
  visibleDestinations,
} from "@/src/lib/nav/destinations";

const RAIL_GROUP_LABELS: Record<
  RailGroup,
  | "railGroupHosts"
  | "railGroupAccess"
  | "railGroupSecurity"
  | "railGroupObservability"
  | "railGroupSystem"
> = {
  hosts: "railGroupHosts",
  access: "railGroupAccess",
  security: "railGroupSecurity",
  observability: "railGroupObservability",
  system: "railGroupSystem",
};

type User = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string;
};

/** DataTable's card-view edge, so the phone layout switches in one place. */
const NARROW = "(max-width: 767px)";

function ThemeToggle() {
  // useTheme reports the resolved mode, so a click pins the opposite one and leaves "system".
  const t = useTranslations("common.theme");
  const { mode } = useTheme();
  const { setMode } = useThemeMode();
  const isDark = mode === "dark";
  return (
    <IconButton
      variant="ghost"
      size="sm"
      label={isDark ? t("toLight") : t("toDark")}
      icon={isDark ? <Moon /> : <Sun />}
      onClick={() => setMode(isDark ? "light" : "dark")}
    />
  );
}

function SignOutButton() {
  const t = useTranslations("common");
  return (
    <form action="/api/auth/logout" method="POST">
      <IconButton variant="ghost" size="sm" label={t("signOut")} icon={<LogOut />} type="submit" />
    </form>
  );
}

function UserFooter({ user, avatar }: { user: User; avatar: ResolvedAvatar }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const { closeMobileNav } = useAppShellMobile();

  return (
    <HStack gap={2} vAlign="center" justify="between" width="100%">
      <HStack
        gap={2}
        vAlign="center"
        as="button"
        onClick={() => {
          router.push("/profile");
          closeMobileNav();
        }}
      >
        <UserAvatar avatar={avatar} alt={user.name ?? t("avatarAlt")} size="sm" />
        <VStack hAlign="start">
          <Text type="body" size="sm" weight="medium" maxLines={1}>
            {user.name ?? t("defaultUserName")}
          </Text>
          <Text type="body" size="xsm" color="secondary" maxLines={1}>
            {user.email}
          </Text>
        </VStack>
      </HStack>
      <HStack gap={1} vAlign="center">
        <LocaleSwitcher />
        <ThemeToggle />
        <SignOutButton />
      </HStack>
    </HStack>
  );
}

export default function DashboardLayoutClient({
  user,
  avatar,
  appName,
  demoMode = false,
  sqliteNotice = false,
  updateAvailable,
  stagedKeys,
  morePins,
  viewAs = null,
  children,
}: {
  user: User;
  avatar: ResolvedAvatar;
  appName: string;
  demoMode?: boolean;
  /** A real instance on SQLite, and this browser has not dismissed the warning lately. */
  sqliteNotice?: boolean;
  updateAvailable: boolean;
  /** So the settings rail can mark their sections. */
  stagedKeys: readonly string[];
  /** Null if the user never customized the More drawer. */
  morePins: readonly DestinationId[] | null;
  /** See lib/view-as.ts. */
  viewAs?: { role: string; groupNames: string[] } | null;
  children: ReactNode;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const isNarrow = useMediaQuery(NARROW);
  // Keyed to the path it opened on, so any navigation closes it with no effect to keep in step.
  const [moreOpenOn, setMoreOpenOn] = useState<string | null>(null);
  const isMoreOpen = moreOpenOn === pathname;
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // The rail's footer reaches Profile on a desktop.
  const railItems = visibleDestinations(user.role).filter((d) => d.id !== "profile");
  const drawerItems = resolveDrawer(morePins, user.role);

  // An element, as the Settings rail passes: SideNavItem draws a component smaller.
  const renderRailItem = ({ id, href, labelKey }: Destination) => {
    const RailIcon = DESTINATION_ICONS[id];
    return (
      <SideNavItem
        key={href}
        as={Link}
        href={href}
        label={t(labelKey)}
        icon={<RailIcon className={ACCENTS[DESTINATION_HUES[id]].text} />}
        isSelected={pathname === href}
      />
    );
  };

  const closeMore = useCallback(() => setMoreOpenOn(null), []);
  const toggleMore = useCallback(
    () => setMoreOpenOn((openOn) => (openOn === pathname ? null : pathname)),
    [pathname],
  );

  // Settings renders its own header and padding; the list-detail pages their own full-bleed frame.
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const isFullBleed = inSettings || ["/access-lists", "/users", "/groups"].includes(pathname);

  // On a phone the tab bar is the navigation, so AppShell's hamburger is off.
  const mobileChrome = isNarrow ? (
    <>
      <MoreDrawer
        isOpen={isMoreOpen}
        onClose={closeMore}
        items={drawerItems}
        totalPages={moreDestinations(user.role).length}
        offerCustomize={morePins === null}
        returnFocusRef={moreButtonRef}
      />
      <MobileTabBar
        role={user.role}
        isMoreOpen={isMoreOpen}
        onToggleMore={toggleMore}
        onCloseMore={closeMore}
        moreButtonRef={moreButtonRef}
      />
    </>
  ) : null;
  const content = <div className="cpm-mobile-content">{children}</div>;
  // View-as first: the way back must be on every page. The demo banner is not dismissable; the
  // SQLite one is, for a while (src/lib/sqlite-notice.ts).
  const banner = viewAs ? (
    <Banner
      status="warning"
      container="section"
      title={
        viewAs.groupNames.length > 0
          ? t("viewAsBannerTitleGroups", {
              role: t(`viewAsRoles.${viewAs.role as "operator" | "user" | "viewer"}`),
              groups: viewAs.groupNames.join(", "),
            })
          : t("viewAsBannerTitle", {
              role: t(`viewAsRoles.${viewAs.role as "operator" | "user" | "viewer"}`),
            })
      }
      description={t("viewAsBannerDescription")}
      endContent={
        <Button
          variant="secondary"
          size="sm"
          label={t("viewAsReturn")}
          onClick={async () => {
            await stopViewAsAction();
            // A full load: the whole shell changes.
            window.location.reload();
          }}
        />
      }
    />
  ) : demoMode ? (
    <Banner
      status="info"
      container="section"
      title={t("demoBannerTitle")}
      description={t("demoBannerDescription")}
    />
  ) : sqliteNotice ? (
    <Banner
      status="warning"
      container="section"
      title={t("sqliteBannerTitle")}
      description={t("sqliteBannerDescription")}
      isDismissable
      onDismiss={() => {
        // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is Chromium-only; see ThemeModeProvider
        document.cookie = `${SQLITE_NOTICE_COOKIE}=1; path=/; max-age=${SQLITE_NOTICE_DISMISS_SECONDS}; SameSite=Lax`;
      }}
    />
  ) : undefined;

  // Settings takes the rail over; its first row is the way back (./settings/SettingsSideNav.tsx).
  if (inSettings) {
    return (
      <GlobalCommandPaletteProvider role={user.role}>
        <AppShell
          banner={banner}
          contentPadding={0}
          mobileNav={false}
          sideNav={
            <SettingsSideNav
              footer={<UserFooter user={user} avatar={avatar} />}
              stagedKeys={stagedKeys}
            />
          }
        >
          {content}
        </AppShell>
        {mobileChrome}
      </GlobalCommandPaletteProvider>
    );
  }

  return (
    <GlobalCommandPaletteProvider role={user.role}>
      <AppShell
        banner={banner}
        contentPadding={isFullBleed ? 0 : 6}
        mobileNav={false}
        sideNav={
          <SideNav
            header={
              <SideNavHeading
                heading={appName}
                headingHref="/"
                subheading={formatAppVersion()}
                // Beside the version, not a banner, so there is nothing to dismiss.
                subheadingHref={updateAvailable ? "/settings" : undefined}
                headerEndContent={
                  updateAvailable ? <Badge variant="warning" label={t("updateBadge")} /> : undefined
                }
                icon={
                  <NavIcon
                    icon={
                      <Text type="body" size="xsm" weight="bold">
                        C
                      </Text>
                    }
                  />
                }
              />
            }
            footer={<UserFooter user={user} avatar={avatar} />}
          >
            {/* No shortcut to advertise on a phone, where the tab bar navigates. */}
            <div className="cpm-desktop-only">
              <VStack padding={2}>
                <PaletteSearchButton />
              </VStack>
            </div>
            {/* Laid out like the Settings rail; an empty group is skipped. */}
            <SideNavSection title={t("sectionLabel")} isHeaderHidden>
              {railItems.filter((d) => !d.railGroup).map(renderRailItem)}
            </SideNavSection>
            {RAIL_GROUPS.map((group) => {
              const items = railItems.filter((d) => d.railGroup === group);
              if (items.length === 0) return null;
              return (
                <SideNavSection key={group} title={t(RAIL_GROUP_LABELS[group])}>
                  {items.map(renderRailItem)}
                </SideNavSection>
              );
            })}
          </SideNav>
        }
      >
        {content}
      </AppShell>
      {mobileChrome}
    </GlobalCommandPaletteProvider>
  );
}
