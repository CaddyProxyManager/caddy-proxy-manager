"use client";

/**
 * Our own: Astryx's `ResizeHandle` is not exported. Width lives in localStorage, read after mount
 * so SSR agrees. Render it right after the LayoutPanel, which takes `width` and no `hasDivider`.
 */
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const STORAGE_PREFIX = "cpm-panel-width:";
const KEY_STEP = 16;

type WidthBounds = { defaultWidth: number; minWidth: number; maxWidth: number };

function clamp(value: number, { minWidth, maxWidth }: WidthBounds): number {
  return Math.round(Math.min(maxWidth, Math.max(minWidth, value)));
}

export function usePersistedPanelWidth(storageKey: string, bounds: WidthBounds) {
  const { defaultWidth, minWidth, maxWidth } = bounds;
  const [width, setWidthState] = useState(defaultWidth);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
      const stored = raw === null ? Number.NaN : Number(raw);
      if (Number.isFinite(stored)) {
        setWidthState(clamp(stored, { defaultWidth, minWidth, maxWidth }));
      }
    } catch {
      // Storage unavailable: the default width stands.
    }
  }, [storageKey, defaultWidth, minWidth, maxWidth]);

  const setWidth = useCallback(
    (next: number) => setWidthState(clamp(next, { defaultWidth, minWidth, maxWidth })),
    [defaultWidth, minWidth, maxWidth],
  );

  const save = useCallback(
    (next: number) => {
      try {
        const value = clamp(next, { defaultWidth, minWidth, maxWidth });
        if (value === defaultWidth) {
          window.localStorage.removeItem(STORAGE_PREFIX + storageKey);
        } else {
          window.localStorage.setItem(STORAGE_PREFIX + storageKey, String(value));
        }
      } catch {
        // Not remembered this time; the width still applies until the page is left.
      }
    },
    [storageKey, defaultWidth, minWidth, maxWidth],
  );

  return { width, setWidth, save, ...bounds };
}

export function PanelResizeHandle({
  label,
  panel,
}: {
  /** The separator's accessible name, e.g. "Resize the access list panel". */
  label: string;
  panel: ReturnType<typeof usePersistedPanelWidth>;
}) {
  const { width, setWidth, save, defaultWidth, minWidth, maxWidth } = panel;
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, latest: width };
    setIsDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    // Dragging towards inline-end widens it, which is leftwards in RTL.
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const delta = (event.clientX - state.startX) * (rtl ? -1 : 1);
    state.latest = clamp(state.startWidth + delta, panel);
    setWidth(state.latest);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    save(state.latest);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const grow = rtl ? "ArrowLeft" : "ArrowRight";
    const shrink = rtl ? "ArrowRight" : "ArrowLeft";
    let next: number | null = null;
    if (event.key === grow) next = width + KEY_STEP;
    else if (event.key === shrink) next = width - KEY_STEP;
    else if (event.key === "Home") next = minWidth;
    else if (event.key === "End") next = maxWidth;
    else if (event.key === "Enter") next = defaultWidth;
    if (next === null) return;
    event.preventDefault();
    const value = clamp(next, panel);
    setWidth(value);
    save(value);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus (ARIA splitter)
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title={label}
      className="cpm-panel-resize-handle"
      data-dragging={isDragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        setWidth(defaultWidth);
        save(defaultWidth);
      }}
    />
  );
}
