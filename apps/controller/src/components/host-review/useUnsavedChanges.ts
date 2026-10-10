"use client";

import { useEffect, useRef, useState } from "react";

type Snapshot = Map<string, string>;

const SETTLE_MS = 800;

/** Markers and the review's own undo entries are not edits. */
function counted(name: string): boolean {
  return !name.endsWith("Present") && name !== "revertField";
}

function snapshot(form: HTMLFormElement): Snapshot {
  const values = new Map<string, string[]>();
  for (const [name, value] of new FormData(form)) {
    if (!counted(name)) continue;
    const list = values.get(name) ?? [];
    list.push(typeof value === "string" ? value : value.name);
    values.set(name, list);
  }
  return new Map([...values].map(([name, list]) => [name, JSON.stringify(list)]));
}

/** How many form fields differ from the baseline. */
export function countChangedFields(baseline: Snapshot, current: Snapshot): number {
  let count = 0;
  for (const name of new Set([...baseline.keys(), ...current.keys()])) {
    if ((baseline.get(name) ?? "[]") !== (current.get(name) ?? "[]")) count += 1;
  }
  return count;
}

export type UnsavedChanges = {
  /** Fields that differ from what the form opened with. */
  changed: number;
  /** Fields the browser would refuse to submit, once the user has touched the form. */
  invalid: number;
};

/** The controls the browser checks on submit; a hidden input never validates. */
function countInvalidFields(form: HTMLFormElement): number {
  let count = 0;
  for (const element of form.elements) {
    if (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) &&
      element.willValidate &&
      !element.validity.valid
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Counts the form's fields that differ from what it opened with, and the ones the browser would
 * refuse. The editors are mostly uncontrolled, so this reads the form itself. Until the user first
 * touches it, every reading becomes the baseline: fields that fill themselves in after mount are
 * not edits, and a required field still empty is not yet a mistake.
 */
export function useUnsavedChanges(formId: string, active: boolean): UnsavedChanges {
  const [count, setCount] = useState<UnsavedChanges>({ changed: 0, invalid: 0 });
  const baseline = useRef<Snapshot | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (!active) return;
    baseline.current = null;
    touched.current = false;
    setCount({ changed: 0, invalid: 0 });

    let form: HTMLFormElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;

    const measure = () => {
      if (!form?.isConnected) return;
      const now = snapshot(form);
      if (!touched.current || baseline.current === null) {
        baseline.current = now;
        setCount({ changed: 0, invalid: 0 });
        return;
      }
      const changed = countChangedFields(baseline.current, now);
      const invalid = countInvalidFields(form);
      setCount((prev) =>
        prev.changed === changed && prev.invalid === invalid ? prev : { changed, invalid },
      );
    };
    // After React has re-rendered whatever the event changed.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, 120);
    };
    const onEdit = () => {
      touched.current = true;
      schedule();
    };

    // The dialog mounts its content a frame after opening.
    let frame = requestAnimationFrame(function attach() {
      form = document.getElementById(formId) as HTMLFormElement | null;
      if (!form) {
        frame = requestAnimationFrame(attach);
        return;
      }
      measure();
      // A pick from a custom selector fires no input event, so the baseline cannot wait for one.
      settle = setTimeout(() => {
        touched.current = true;
      }, SETTLE_MS);
      for (const type of ["input", "change", "click"]) form.addEventListener(type, onEdit);
      observer = new MutationObserver(schedule);
      observer.observe(form, { subtree: true, childList: true, attributes: true });
    });

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      clearTimeout(timer);
      observer?.disconnect();
      if (form)
        for (const type of ["input", "change", "click"]) form.removeEventListener(type, onEdit);
    };
  }, [formId, active]);

  return count;
}
