"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import { stopViewAsAction } from "./view-as/actions";
import { unwrap } from "@/src/lib/errors/action-result";
import { Button } from "@astryxdesign/core/Button";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { TIMESTAMP_STYLES } from "@/components/ui/Timestamp";
import { useTheme } from "@astryxdesign/core";
import { LogOut, ServerCog, Sun, Moon } from "lucide-react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import SettingsSideNav from "./settings/SettingsSideNav";
import { RailStagedBlock } from "./settings/StagedChanges";
import type { StagedView } from "@/src/lib/settings/staged-view";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
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
import { APP_VERSION, appVersionLabel } from "@/src/lib/runtime/app-version";
import {
  SQLITE_NOTICE_COOKIE,
  SQLITE_NOTICE_DISMISS_SECONDS,
} from "@/src/lib/db/sqlite-notice-cookie";
import type { ResolvedAvatar } from "@/src/lib/users/avatar";
import type { CapabilitySet } from "@/src/lib/roles/capabilities";
import {
  type Destination,
  type DestinationId,
  moreDestinations,
  RAIL_GROUPS,
  type RailGroup,
  resolveDrawer,
  visibleDestinations,
} from "@/src/lib/nav/destinations";

/** Under `nav`: a group named like a page shares that page's label. */
const RAIL_GROUP_LABELS: Record<
  RailGroup,
  "hosts" | "railGroupAccess" | "security" | "railGroupObservability" | "railGroupSystem"
> = {
  hosts: "hosts",
  access: "railGroupAccess",
  security: "security",
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
          <Text type="body" size="sm" color="secondary" maxLines={1}>
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
  staged,
  morePins,
  capabilities,
  viewAs = null,
  mfaDeadline = null,
  pendingReviews = null,
  awaitingApprovals = 0,
  children,
}: {
  user: User;
  avatar: ResolvedAvatar;
  appName: string;
  demoMode?: boolean;
  /** A real instance on SQLite, and this browser has not dismissed the warning lately. */
  sqliteNotice?: boolean;
  updateAvailable: boolean;
  /** Null without settings:read. The rails show its revision; Settings marks staged sections. */
  staged: StagedView | null;
  /** Null if the user never customized the More drawer. */
  morePins: readonly DestinationId[] | null;
  /** What the viewer may do, which decides the pages the nav offers. */
  capabilities: CapabilitySet;
  /** See lib/users/view-as.ts. */
  /** `roleName` for a made role; a built-in one is named from the catalog. */
  viewAs?: { role: string; roleName?: string | null; groupNames: string[] } | null;
  /** Inside a two-factor policy's grace period: when setup becomes compulsory. */
  mfaDeadline?: string | null;
  /** Access review items waiting on this person, and the soonest due date among them. */
  pendingReviews?: { count: number; dueOn: string | null } | null;
  /** Change requests this person could approve and has not decided. */
  awaitingApprovals?: number;
  children: ReactNode;
}) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const pathname = usePathname();
  const isNarrow = useMediaQuery(NARROW);
  // Keyed to the path it opened on, so any navigation closes it with no effect to keep in step.
  const [moreOpenOn, setMoreOpenOn] = useState<string | null>(null);
  const isMoreOpen = moreOpenOn === pathname;
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // The rail's footer reaches Profile on a desktop.
  const railItems = visibleDestinations(capabilities).filter((d) => d.id !== "profile");
  const drawerItems = resolveDrawer(morePins, capabilities);

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
        totalPages={moreDestinations(capabilities).length}
        offerCustomize={morePins === null}
        returnFocusRef={moreButtonRef}
      />
      <MobileTabBar
        capabilities={capabilities}
        isMoreOpen={isMoreOpen}
        onToggleMore={toggleMore}
        onCloseMore={closeMore}
        moreButtonRef={moreButtonRef}
      />
    </>
  ) : null;
  const content = <div className="cpm-mobile-content">{children}</div>;
  // View-as first: the way back must be on every page. The demo banner is not dismissable; the
  // SQLite one is, for a while (src/lib/db/sqlite-notice.ts).
  const viewAsRole = viewAs
    ? (viewAs.roleName ?? t(`viewAsRoles.${viewAs.role as "operator" | "user" | "viewer"}`))
    : "";
  const banner = viewAs ? (
    <Banner
      status="warning"
      container="section"
      title={
        viewAs.groupNames.length > 0
          ? t("viewAsBannerTitleGroups", {
              role: viewAsRole,
              groups: viewAs.groupNames.join(", "),
            })
          : t("viewAsBannerTitle", { role: viewAsRole })
      }
      description={t("viewAsBannerDescription")}
      endContent={
        <Button
          variant="secondary"
          size="sm"
          label={t("viewAsExit")}
          onClick={async () => {
            unwrap(await stopViewAsAction());
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
  ) : mfaDeadline ? (
    <Banner
      status="warning"
      container="section"
      title={t("mfaGraceTitle", {
        date: format.dateTime(new Date(mfaDeadline), TIMESTAMP_STYLES.date),
      })}
      description={t("mfaGraceDescription")}
      endContent={
        <Button
          variant="secondary"
          size="sm"
          label={t("mfaGraceAction")}
          href="/profile#two-factor"
        />
      }
    />
  ) : pendingReviews && !pathname.startsWith("/users/access-reviews") ? (
    <Banner
      status="info"
      container="section"
      title={t("pendingReviewsTitle", { count: pendingReviews.count })}
      description={
        pendingReviews.dueOn
          ? t("pendingReviewsDue", {
              date: format.dateTime(new Date(`${pendingReviews.dueOn}T00:00:00Z`), {
                dateStyle: "medium",
                timeZone: "UTC",
              }),
            })
          : undefined
      }
      endContent={
        <Button
          variant="secondary"
          size="sm"
          label={tCommon("review")}
          href="/users/access-reviews"
        />
      }
    />
  ) : awaitingApprovals > 0 && !pathname.startsWith("/approvals") ? (
    <Banner
      status="info"
      container="section"
      title={t("awaitingApprovalsTitle", { count: awaitingApprovals })}
      endContent={
        <Button variant="secondary" size="sm" label={tCommon("review")} href="/approvals" />
      }
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
      <GlobalCommandPaletteProvider capabilities={capabilities}>
        <AppShell
          banner={banner}
          contentPadding={0}
          mobileNav={false}
          sideNav={
            <SettingsSideNav
              footer={<UserFooter user={user} avatar={avatar} />}
              stagedKeys={staged?.changes.map((change) => change.key) ?? []}
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
    <GlobalCommandPaletteProvider capabilities={capabilities}>
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
                subheading={appVersionLabel(
                  appName,
                  tCommon("versionNumber", { version: APP_VERSION }),
                )}
                icon={
                  // Inherits NavIcon's dark ink; Text would paint white on the light accent.
                  <NavIcon icon={<Icon icon={ServerCog} />} />
                }
              />
            }
            footer={
              // As in Settings: some settings live on pages of their own, which apply them too.
              staged ? (
                <VStack gap={2}>
                  <RailStagedBlock staged={staged} />
                  <UserFooter user={user} avatar={avatar} />
                </VStack>
              ) : (
                <UserFooter user={user} avatar={avatar} />
              )
            }
          >
            {/* No shortcut to advertise on a phone, where the tab bar navigates. */}
            <div className="cpm-desktop-only">
              <VStack padding={2} gap={2}>
                {/* Not a banner, so there is nothing to dismiss; not in the heading, which is one
                    link home, and whose xsm version link is under axe's 24px target size. */}
                {updateAvailable && (
                  <Button
                    label={t("updateBadge")}
                    size="sm"
                    width="100%"
                    href="/settings"
                    as={Link}
                  />
                )}
                <PaletteSearchButton />
              </VStack>
            </div>
            {/* Laid out like the Settings rail; an empty group is skipped. */}
            <SideNavSection title={t("more.navigation")} isHeaderHidden>
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
