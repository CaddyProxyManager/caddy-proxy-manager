"use client";

import { ChevronDown } from "lucide-react";

/**
 * A pill that opens a sheet, where six segments do not fit and a native select hides the choices
 * anyway. `isActive` fills it with the accent when the filter is off its default.
 */
export function FilterChip({
  label,
  isActive = false,
  onClick,
  "aria-label": ariaLabel,
}: {
  label: string;
  isActive?: boolean;
  onClick: () => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      className="cpm-chip"
      data-active={isActive || undefined}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );
}
