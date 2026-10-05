"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";

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
  return (
    <Button
      className="cpm-fab"
      variant="primary"
      size="lg"
      elevation="high"
      isIconOnly
      icon={icon ?? <Plus />}
      label={label}
      tooltip={label}
      onClick={onClick}
      href={isDisabled ? undefined : href}
      isDisabled={isDisabled}
    />
  );
}
