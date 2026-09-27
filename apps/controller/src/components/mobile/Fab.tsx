"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";

/**
 * Rendered at every width and hidden by CSS above the narrow edge, so SSR and client markup agree
 * and display: none keeps it out of the accessibility tree beside the page's own button.
 */
export function Fab({
  label,
  icon,
  onClick,
  href,
  isDisabled = false,
}: {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  href?: string;
  isDisabled?: boolean;
}) {
  const content = icon ?? <Plus size={24} strokeWidth={2} aria-hidden="true" />;

  if (href && !isDisabled) {
    return (
      <Link href={href} className="cpm-fab" aria-label={label} title={label}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className="cpm-fab"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={isDisabled}
    >
      {content}
    </button>
  );
}
