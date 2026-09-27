"use client";

/**
 * Migration and setup both leave a process running on answers resolved at boot (settings, OAuth
 * providers, the env backfill), and only a restart applies the new Caddy config. The wait is down
 * first, then up, or the exiting process would satisfy it. No supervisor is valid: it says so.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Code } from "@astryxdesign/core/Code";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { loadPage } from "@/src/lib/browser-navigation";

const POLL_INTERVAL_MS = 1000;
const SHUTDOWN_BUDGET_MS = 20_000;
/** Generous: a cold start pulls in the whole app. */
const STARTUP_BUDGET_MS = 120_000;
/** Short: only the gap until Caddy has the route, spent on a finished page. */
const DASHBOARD_BUDGET_MS = 15_000;
/** The route allows one restart a minute; migrate-then-setup inside it is waited out. */
const COOLDOWN_BUDGET_MS = 90_000;

/** The two flows share the machinery, not the sentences. */
export type RestartCopy = {
  heading: string;
  lead: string;
  title: string;
  description: string;
  note: string;
  /** For when nothing restarted the app. */
  manually: string;
  manuallyWithDetail: (detail: string) => string;
};

type Phase =
  /** Waiting out the last restart's cooldown. */
  | "queued"
  /** The old process is still answering. */
  | "stopping"
  | "starting"
  | "ready"
  /** The operator finishes by hand. */
  | "stalled";

/** Data, so the words are chosen at render. */
type Detail =
  /** Already translated on the server. */
  | { message: string }
  | { code: "refused"; status: number }
  | { code: "stillRunning" }
  | { code: "notBack" };

async function isUp(): Promise<boolean> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

/** Asked of the server, which checks a signed nonce: an opaque cross-origin fetch cannot tell. */
async function dashboardAnswers(): Promise<boolean> {
  try {
    const response = await fetch("/api/setup/dashboard-reachable", { cache: "no-store" });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function RestartDialog({
  next,
  restartToken,
  copy,
  preferredOrigin = null,
}: {
  next: string;
  /** Single-use proof that this browser ran the step. */
  restartToken: string;
  copy: RestartCopy;
  /** The dashboard host's origin, used only if it answers, lest setup end on a browser error. */
  preferredOrigin?: string | null;
}) {
  const t = useTranslations("setup");
  const [phase, setPhase] = useState<Phase>("stopping");
  // Translated at render: `t` in the effect's deps would re-run it and cancel the restart.
  const [detail, setDetail] = useState<Detail | null>(null);
  // Strict Mode runs effects twice in development; never ask a process to exit twice.
  const started = useRef(false);

  const goOn = useCallback(
    (origin?: string) => {
      // A full load: nothing client-side should carry across to the new process.
      loadPage(origin ? `${origin}${next}` : next);
    },
    [next],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;

    void (async () => {
      const deadline = Date.now() + COOLDOWN_BUDGET_MS;
      // Loops only for a cooldown; every other answer leaves it on the first pass.
      for (;;) {
        try {
          const response = await fetch("/api/setup/restart", {
            method: "POST",
            headers: { "x-cpm-restart-token": restartToken },
          });
          if (response.status === 429 && Date.now() < deadline) {
            const after = Number(response.headers.get("retry-after"));
            if (cancelled) return;
            setPhase("queued");
            await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : POLL_INTERVAL_MS);
            if (cancelled) return;
            setPhase("stopping");
            continue;
          }
          if (!response.ok && response.status !== 202) {
            const body = (await response.json().catch(() => null)) as { error?: string } | null;
            if (!cancelled) {
              setDetail(
                body?.error != null
                  ? { message: body.error }
                  : { code: "refused", status: response.status },
              );
              setPhase("stalled");
            }
            return;
          }
        } catch {
          // The connection dropping as the process exits is normal; the polling below decides.
        }
        break;
      }

      // Down first, or the process on its way out would pass the poll.
      const shutdownBy = Date.now() + SHUTDOWN_BUDGET_MS;
      while (!cancelled && Date.now() < shutdownBy) {
        if (!(await isUp())) break;
        await sleep(POLL_INTERVAL_MS);
      }
      if (cancelled) return;

      if (await isUp()) {
        setDetail({ code: "stillRunning" });
        setPhase("stalled");
        return;
      }

      setPhase("starting");

      const startupBy = Date.now() + STARTUP_BUDGET_MS;
      while (!cancelled && Date.now() < startupBy) {
        if (await isUp()) {
          if (cancelled) return;
          setPhase("ready");

          // Caddy is configured as the app starts, so the route can lag it by a moment.
          if (preferredOrigin) {
            const dashboardBy = Date.now() + DASHBOARD_BUDGET_MS;
            while (!cancelled && Date.now() < dashboardBy) {
              if (await dashboardAnswers()) {
                if (cancelled) return;
                goOn(preferredOrigin);
                return;
              }
              await sleep(POLL_INTERVAL_MS);
            }
            if (cancelled) return;
          }

          goOn();
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      if (cancelled) return;

      setDetail({ code: "notBack" });
      setPhase("stalled");
    })();

    return () => {
      cancelled = true;
    };
  }, [goOn, restartToken, preferredOrigin]);

  const waiting = phase !== "stalled";

  const detailText =
    detail === null
      ? null
      : "message" in detail
        ? detail.message
        : detail.code === "refused"
          ? t("restartRefused", { status: detail.status })
          : detail.code === "stillRunning"
            ? t("restartStillRunning")
            : t("restartNotBack");

  return (
    <Center>
      <VStack gap={2} padding={5}>
        <Heading level={1}>{copy.heading}</Heading>
        <Text color="secondary">{copy.lead}</Text>
      </VStack>

      <Dialog isOpen onOpenChange={() => {}} width={560} purpose="required">
        <Layout
          header={<DialogHeader title={copy.title} />}
          content={
            <LayoutContent>
              <VStack gap={4}>
                <Text size="sm" color="secondary">
                  {copy.description}
                </Text>

                {waiting ? (
                  <HStack gap={3} align="center">
                    <Spinner />
                    <Text size="sm">
                      {phase === "queued"
                        ? t("restartQueued")
                        : phase === "stopping"
                          ? t("restartStopping")
                          : phase === "starting"
                            ? t("restartWaiting")
                            : t("restartReady")}
                    </Text>
                  </HStack>
                ) : (
                  <VStack gap={3}>
                    <Banner
                      status="warning"
                      title={t("restartFailedTitle")}
                      description={detailText ? copy.manuallyWithDetail(detailText) : copy.manually}
                    />
                    <Text size="sm" color="secondary">
                      {t("composeRestartHelp")}
                    </Text>
                    <Code>docker compose --profile caddy restart web agent caddy</Code>
                  </VStack>
                )}

                <Text size="xsm" color="secondary">
                  {copy.note}
                </Text>
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} justify="end">
                <Button
                  variant={phase === "stalled" ? "primary" : "secondary"}
                  label={
                    phase === "stalled" ? t("restartContinue") : t("restartContinueWithoutWaiting")
                  }
                  onClick={() => goOn()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </Center>
  );
}
