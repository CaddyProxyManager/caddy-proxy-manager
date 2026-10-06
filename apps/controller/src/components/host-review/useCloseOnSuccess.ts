"use client";

import { useEffect, useRef } from "react";

/**
 * Closes a dialog a second after its action succeeds. Keyed on status alone: `onClose` is new each
 * render, and a render inside that second (a refreshed `?edit=` target) would cancel the timer.
 * A reopened dialog must remount to start clean (#241).
 */
export function useCloseOnSuccess(state: { status: string }, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (state.status !== "success") return;
    const timer = setTimeout(() => onCloseRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [state.status]);
}
