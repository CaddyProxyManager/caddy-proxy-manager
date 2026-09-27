"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { type Destination, MORE_DRAWER_SLOTS } from "@/src/lib/nav/destinations";
import { DESTINATION_ICONS } from "./nav-icons";

/**
 * Not Astryx's modal BottomSheet: a modal makes the tab bar inert, so a second tap on More could
 * never land. Unmounted when closed, or every page name is duplicated for find-in-page, screen
 * readers and test locators.
 */
export function MoreDrawer({
  isOpen,
  onClose,
  items,
  totalPages,
  offerCustomize,
  returnFocusRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  items: Destination[];
  /** How many pages All pages leads to, for its caption. */
  totalPages: number;
  /** Until the user has customized the drawer once. */
  offerCustomize: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("nav");
  const tMore = useTranslations("nav.more");
  const pathname = usePathname();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const returnTo = returnFocusRef.current;
    sheetRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnTo?.focus();
    };
  }, [isOpen, onClose, returnFocusRef]);

  if (!isOpen) return null;

  return (
    <>
      <div className="cpm-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        className="cpm-sheet"
        role="dialog"
        aria-label={tMore("jumpTo")}
        tabIndex={-1}
      >
        <div className="cpm-sheet-handle" aria-hidden="true" />
        <h2 className="cpm-sheet-title">{tMore("jumpTo")}</h2>
        <div className="cpm-drawer-grid">
          {items.map((item) => {
            const Icon = DESTINATION_ICONS[item.id];
            const isCurrent = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.id}
                href={item.href}
                className="cpm-tile"
                data-current={isCurrent || undefined}
                aria-current={isCurrent ? "page" : undefined}
                onClick={onClose}
              >
                <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                <span className="cpm-tile-label">{t(item.labelKey)}</span>
              </Link>
            );
          })}
          <Link href="/more" className="cpm-tile cpm-tile-all" onClick={onClose}>
            <LayoutGrid size={22} strokeWidth={1.75} aria-hidden="true" />
            <span className="cpm-tile-label">{tMore("allPages")}</span>
            <span className="cpm-tile-caption">
              {tMore("allPagesCount", { count: totalPages })}
            </span>
          </Link>
        </div>
        {offerCustomize && (
          <Link href="/more/customize" className="cpm-sheet-row" onClick={onClose}>
            <SlidersHorizontal size={19} strokeWidth={1.75} aria-hidden="true" />
            <span className="cpm-sheet-row-text">
              <span className="cpm-sheet-row-label">{tMore("customize")}</span>
              <span className="cpm-sheet-row-caption">
                {tMore("customizeDescription", { max: MORE_DRAWER_SLOTS })}
              </span>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </Link>
        )}
      </div>
    </>
  );
}
