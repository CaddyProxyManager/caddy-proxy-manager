"use client";

import { useMemo } from "react";
import { useTheme } from "@astryxdesign/core";
import type { ApexOptions } from "apexcharts";

/**
 * ApexCharts options from the active Astryx theme. ApexCharts writes concrete colours into SVG
 * attributes, so it cannot take `var(--color-…)`; `useTheme().token()` resolves each `light-dark()`
 * pair to the value in effect, and re-resolves on mode change.
 */
export interface ChartTheme {
  /** Resolved mode - ApexCharts has its own light/dark defaults keyed off this. */
  mode: "light" | "dark";
  base: ApexOptions;
  labelColor: string;
  /** Identical in light and dark on purpose, so a series keeps identity. */
  series: {
    blue: string;
    red: string;
    purple: string;
    cyan: string;
    orange: string;
    green: string;
  };
  /** Text drawn on top of a filled series colour (donut slice labels). */
  onSeries: string;
}

export function useChartTheme(): ChartTheme {
  // `tokens`, not `token()`, which is rebuilt every render and would defeat the useMemo.
  const { mode, tokens } = useTheme();

  return useMemo(() => {
    const token = (name: string) => tokens[name] ?? "";
    const labelColor = token("--color-text-secondary");

    return {
      mode,
      labelColor,
      base: {
        chart: {
          background: "transparent",
          toolbar: { show: false },
          animations: { enabled: false },
        },
        theme: { mode },
        grid: { borderColor: token("--color-border") },
        tooltip: { theme: mode },
      },
      series: {
        blue: token("--color-data-categorical-blue"),
        red: token("--color-data-categorical-red"),
        purple: token("--color-data-categorical-purple"),
        cyan: token("--color-data-categorical-cyan"),
        orange: token("--color-data-categorical-orange"),
        green: token("--color-data-categorical-green"),
      },
      // Saturated mid-tones, so "on dark" stays legible on each in both modes.
      onSeries: token("--color-on-dark"),
    };
  }, [mode, tokens]);
}
