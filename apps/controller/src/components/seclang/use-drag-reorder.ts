"use client";

import { type DragEvent, type KeyboardEvent, useState } from "react";

/**
 * Drag-and-drop and arrow-key reordering for a keyed list, as UpstreamInput does it: a row is
 * draggable only while its handle is held, so text in its fields still selects.
 */
export function useDragReorder(move: (from: number, to: number) => void, scope: string) {
  const [armed, setArmed] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const end = () => {
    setArmed(null);
    setDragging(null);
  };

  return {
    dragging,
    rowProps: (index: number) => ({
      draggable: armed === index,
      onDragStart: (event: DragEvent) => {
        // A nested list's rows sit inside an outer row; only the innermost one moves.
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        // Firefox starts no drag without data.
        event.dataTransfer.setData("text/plain", `${scope}:${index}`);
        setDragging(index);
      },
      onDragOver: (event: DragEvent) => {
        if (dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (dragging !== index) {
          move(dragging, index);
          setDragging(index);
          setArmed(index);
        }
      },
      onDrop: (event: DragEvent) => event.preventDefault(),
      onDragEnd: end,
    }),
    handleProps: (index: number, count: number) => ({
      onPointerDown: () => setArmed(index),
      onPointerUp: () => setArmed(null),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const to = index + (event.key === "ArrowUp" ? -1 : 1);
        if (to >= 0 && to < count) move(index, to);
      },
    }),
  };
}

export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
