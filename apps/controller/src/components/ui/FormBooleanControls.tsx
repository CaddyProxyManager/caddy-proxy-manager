"use client";

/**
 * React 19 resets a `<form action>` after the action, restoring each control to its attribute
 * default, so the next submit sends a stale value. These submit React state via a hidden input.
 */

import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { CheckboxInput as BaseCheckboxInput } from "@astryxdesign/core/CheckboxInput";
import type { CheckboxInputProps } from "@astryxdesign/core/CheckboxInput";
import { Switch as BaseSwitch } from "@astryxdesign/core/Switch";
import type { SwitchProps } from "@astryxdesign/core/Switch";

function booleanFormValue(value: boolean | "indeterminate"): string {
  return value === true ? "on" : "";
}

/**
 * Remounts the control on reset: React never writes back a DOM value the reset changed, so it
 * would show off while state says on and the next click would do nothing. Remounted, not repaired,
 * since the wrapper has no handle on the design system's inner input.
 */
function ResetSafe({
  htmlName,
  value,
  children,
}: {
  htmlName: string;
  value: boolean | "indeterminate";
  children: ReactNode;
}) {
  const anchor = useRef<HTMLInputElement>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const form = anchor.current?.form;
    if (!form) return;
    // Fires before the reset itself is applied, so the remount is queued and lands after it.
    const onReset = () => setGeneration((current) => current + 1);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  return (
    <>
      <Fragment key={generation}>{children}</Fragment>
      <input ref={anchor} type="hidden" name={htmlName} value={booleanFormValue(value)} />
    </>
  );
}

export function Switch({ htmlName, ...props }: SwitchProps) {
  // A disabled control must not submit, as the base components enforce for their own input.
  if (!htmlName || props.isDisabled) return <BaseSwitch {...props} />;
  return (
    <ResetSafe htmlName={htmlName} value={props.value}>
      <BaseSwitch {...props} />
    </ResetSafe>
  );
}

export function CheckboxInput({ htmlName, ...props }: CheckboxInputProps) {
  if (!htmlName || props.isDisabled) return <BaseCheckboxInput {...props} />;
  return (
    <ResetSafe htmlName={htmlName} value={props.value}>
      <BaseCheckboxInput {...props} />
    </ResetSafe>
  );
}
