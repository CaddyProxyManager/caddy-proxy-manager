"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";

/**
 * A button that opens an OptionSheet, where six segments do not fit and a native select hides the
 * choices anyway. Not DropdownMenu: its sheet lists actions, and this one has to show which
 * option is chosen. `isActive` fills it with the accent when the filter is off its default.
 */
export function FilterChip({
  label,
  isActive = false,
  onClick,
  className,
  "aria-label": ariaLabel,
}: {
  label: string;
  isActive?: boolean;
  onClick: () => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Button
      className={className}
      variant={isActive ? "primary" : "secondary"}
      label={ariaLabel ?? label}
      icon={<ChevronDown />}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
