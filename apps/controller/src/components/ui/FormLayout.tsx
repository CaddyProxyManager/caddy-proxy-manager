"use client";

/** Shared by Settings and setup, so a setup page never looks subtly unlike Settings. */
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

export function StatusAlert({ message, success }: { message: string; success: boolean }) {
  return <Banner status={success ? "success" : "error"} title={message} />;
}

export function InfoAlert({ title, children }: { title: string; children?: ReactNode }) {
  return <Banner status="info" title={title} description={children} />;
}

export function WarnAlert({ title, children }: { title: string; children?: ReactNode }) {
  return <Banner status="warning" title={title} description={children} />;
}

export function FormCard({
  title,
  children,
  footer,
}: {
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card padding={4}>
      <VStack gap={4}>
        {title && (
          // Level 2 under every caller's h1. A tighter gap, so the rule reads as part of the
          // heading rather than as the first row of content.
          <VStack gap={2}>
            <Heading level={2}>{title}</Heading>
            <Divider />
          </VStack>
        )}
        {children}
        {footer && (
          <>
            <Divider />
            <HStack justify="end" gap={2}>
              {footer}
            </HStack>
          </>
        )}
      </VStack>
    </Card>
  );
}

/** Plain "Save" unless a form does more: the card title already says what is saved. */
export function SaveButton({ label, isDisabled }: { label?: string; isDisabled?: boolean }) {
  const tCommon = useTranslations("common");
  const anchor = useRef<HTMLInputElement>(null);
  const isDirty = useFormDirty(anchor);
  return (
    <HStack justify="start">
      {/* No name, so it submits nothing: it only lets this button find its form. */}
      <input ref={anchor} type="hidden" />
      <Button
        type="submit"
        variant={isDirty ? "primary" : "secondary"}
        label={label ?? tCommon("save")}
        isDisabled={isDisabled}
      />
    </HStack>
  );
}

/** One comparable string. A file counts by name and size. */
function serializeForm(form: HTMLFormElement): string {
  const entries: string[] = [];
  for (const [key, value] of new FormData(form)) {
    entries.push(`${key}=${typeof value === "string" ? value : `${value.name}:${value.size}`}`);
  }
  return entries.join("\n");
}

/**
 * By value, so an undone change reads clean. A frame after each event, plus a MutationObserver:
 * switches write their hidden inputs from React state, after the click, and announce nothing.
 */
function useFormDirty(anchor: RefObject<HTMLInputElement | null>): boolean {
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    const form = anchor.current?.form;
    if (!form) return;

    let baseline: string | null = null;
    // Never cancelled by a check: fields updating on mount would leave the baseline unset.
    const baselineFrame = requestAnimationFrame(() => {
      baseline = serializeForm(form);
    });
    let frame = 0;

    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (baseline !== null) setIsDirty(serializeForm(form) !== baseline);
      });
    };
    // React resets a form once its action has run; what it holds afterwards is the saved state.
    const rebaseline = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        baseline = serializeForm(form);
        setIsDirty(false);
      });
    };

    const observer = new MutationObserver(check);
    observer.observe(form, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["value", "checked"],
    });
    const events = ["input", "change", "click", "keyup"] as const;
    for (const type of events) form.addEventListener(type, check);
    form.addEventListener("reset", rebaseline);

    return () => {
      cancelAnimationFrame(baselineFrame);
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const type of events) form.removeEventListener(type, check);
      form.removeEventListener("reset", rebaseline);
    };
  }, [anchor]);

  return isDirty;
}
