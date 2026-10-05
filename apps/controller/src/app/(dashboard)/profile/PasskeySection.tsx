"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { AUTOFILL_OFF, nativeAttrs } from "@/components/ui/native-input-attrs";
import { TIMESTAMP_STYLES, UtcTooltip } from "@/components/ui/Timestamp";
import { authClient } from "@/src/lib/auth/client";
import { TRANSLATED_PASSKEY_CODES, passkeyError } from "@/src/lib/auth/passkeys/error";
import { PASSKEY_NAME_MAX_LENGTH } from "@/src/lib/auth/passkeys/relying-party";
import type { PasskeySummary } from "@/src/lib/auth/passkeys";

type Result = { error: { status?: number; code?: string; message?: string } | null };
/** The plugin client's actions, whose inferred types do not survive the plugin-list cast. */
type PasskeyActions = {
  addPasskey: (input: { name?: string }) => Promise<Result>;
  updatePasskey: (input: { id: string; name: string }) => Promise<Result>;
  deletePasskey: (input: { id: string }) => Promise<Result>;
};

/** Why this page cannot make a passkey; null when it can. */
type Blocker = "demo" | "noPublicUrl" | "unsupported" | "insecure" | "wrongHost" | null;

function blockerFor(rpId: string | null, locked: boolean): Blocker {
  if (locked) return "demo";
  if (!rpId) return "noPublicUrl";
  if (!window.PublicKeyCredential) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  // A browser signs only for the rpID or a subdomain of it.
  const host = window.location.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) return "wrongHost";
  return null;
}

type Dialog =
  | { kind: "closed" }
  | { kind: "add" }
  | { kind: "rename"; passkey: PasskeySummary }
  | { kind: "remove"; passkey: PasskeySummary };

/**
 * List, rename, remove and add. Adding needs a sign-in minutes old (auth/server.ts); removing the
 * last way into the account is refused there too, so this page only relays what it is told.
 */
export function PasskeySection({
  passkeys,
  rpId,
  locked,
}: {
  passkeys: PasskeySummary[];
  /** The Public URL's hostname, which every passkey here is bound to. */
  rpId: string | null;
  /** The shared demo account. */
  locked: boolean;
}) {
  const t = useTranslations("profile.passkeys");
  const tPasskey = useTranslations("auth.passkey");
  const format = useFormatter();
  const router = useRouter();
  // Undefined until mounted: the server cannot see the browser's address or its support.
  const [blocker, setBlocker] = useState<Blocker | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog>({ kind: "closed" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlocker(blockerFor(rpId, locked));
  }, [rpId, locked]);

  const actions = (authClient as unknown as { passkey: PasskeyActions }).passkey;
  const labelOf = (passkey: PasskeySummary) => passkey.label ?? t("unnamed");

  const open = (next: Dialog) => {
    setError(null);
    setName(next.kind === "rename" ? (next.passkey.label ?? "") : "");
    setDialog(next);
  };
  const close = () => {
    setDialog({ kind: "closed" });
    setBusy(false);
  };

  /** Null for a cancelled browser prompt, which needs no message. */
  const messageFor = (refused: NonNullable<Result["error"]>, fallback: string): string | null => {
    if (dialog.kind === "add") {
      const message = passkeyError(refused, "register");
      if (message === null) return null;
      return "message" in message ? message.message : tPasskey(message.key);
    }
    // Only CPM's own refusals are translated; the plugin's messages are English.
    return TRANSLATED_PASSKEY_CODES.has(refused.code ?? "") && refused.message
      ? refused.message
      : fallback;
  };

  const finish = async (run: () => Promise<Result>, fallback: string) => {
    setBusy(true);
    setError(null);
    const { error: refused } = await run();
    if (refused) {
      // A cancelled prompt leaves the dialog open, quietly, for another try.
      setError(messageFor(refused, fallback));
      setBusy(false);
      return;
    }
    close();
    router.refresh();
  };

  const trimmed = name.trim();

  const explanation =
    blocker === "demo"
      ? t("demoLocked")
      : blocker === "noPublicUrl"
        ? t("noPublicUrl")
        : blocker === "unsupported"
          ? t("unsupported")
          : blocker === "insecure"
            ? t("insecureContext")
            : blocker === "wrongHost"
              ? t("wrongHost", { host: rpId ?? "", current: window.location.hostname })
              : null;

  return (
    <VStack gap={4}>
      <Text type="body" size="sm" color="secondary">
        {t("description")}
      </Text>

      {explanation &&
        (blocker === "demo" ? (
          <Text type="body" size="sm" color="secondary">
            {explanation}
          </Text>
        ) : (
          <Banner status="info" title={t("unavailableTitle")} description={explanation} />
        ))}

      {passkeys.length === 0 ? (
        <Text type="body" size="sm" color="secondary">
          {t("empty")}
        </Text>
      ) : (
        <List hasDividers>
          {passkeys.map((passkey) => (
            <ListItem
              key={passkey.id}
              startContent={<Icon icon={KeyRound} size="sm" color="secondary" />}
              label={labelOf(passkey)}
              description={
                <HStack gap={2} wrap="wrap" vAlign="center">
                  {passkey.createdAt && (
                    <UtcTooltip value={passkey.createdAt}>
                      <Text type="body" size="xsm" color="secondary">
                        {t("added", {
                          date: format.dateTime(new Date(passkey.createdAt), TIMESTAMP_STYLES.date),
                        })}
                      </Text>
                    </UtcTooltip>
                  )}
                  {passkey.backedUp && <Badge variant="info" label={t("synced")} />}
                </HStack>
              }
              endContent={
                locked ? undefined : (
                  <HStack gap={1}>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label={t("renameNamed", { name: labelOf(passkey) })}
                      tooltip={t("rename")}
                      icon={<Pencil />}
                      onClick={() => open({ kind: "rename", passkey })}
                    />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label={t("removeNamed", { name: labelOf(passkey) })}
                      tooltip={t("remove")}
                      icon={<Trash2 />}
                      onClick={() => open({ kind: "remove", passkey })}
                    />
                  </HStack>
                )
              }
            />
          ))}
        </List>
      )}

      {error && dialog.kind === "closed" && (
        <Banner status="error" title={t("title")} description={error} />
      )}

      {blocker === null && (
        <HStack>
          <Button
            variant="secondary"
            icon={<Plus />}
            label={t("add")}
            onClick={() => open({ kind: "add" })}
          />
        </HStack>
      )}

      <AppDialog
        open={dialog.kind === "add" || dialog.kind === "rename"}
        onClose={close}
        title={dialog.kind === "rename" ? t("renameTitle") : t("addTitle")}
        submitLabel={dialog.kind === "rename" ? t("rename") : t("add")}
        isSubmitting={busy}
        isSubmitDisabled={dialog.kind === "rename" && !trimmed}
        onSubmit={() => {
          if (dialog.kind === "rename") {
            void finish(
              () => actions.updatePasskey({ id: String(dialog.passkey.id), name: trimmed }),
              t("renameFailed"),
            );
          } else {
            void finish(
              () => actions.addPasskey(trimmed ? { name: trimmed } : {}),
              tPasskey("passkeyAddFailed"),
            );
          }
        }}
      >
        <VStack gap={3}>
          {dialog.kind === "add" && (
            <Text type="body" size="sm" color="secondary">
              {t("addHelp")}
            </Text>
          )}
          {error && <Banner status="error" title={t("title")} description={error} />}
          <TextInput
            {...AUTOFILL_OFF}
            {...nativeAttrs({ maxLength: PASSKEY_NAME_MAX_LENGTH })}
            label={t("name")}
            value={name}
            onChange={setName}
            isRequired={dialog.kind === "rename"}
            hasAutoFocus
            width="100%"
          />
        </VStack>
      </AppDialog>

      <AlertDialog
        isOpen={dialog.kind === "remove"}
        onOpenChange={(isOpen) => !isOpen && close()}
        title={t("removeTitle")}
        description={
          dialog.kind === "remove" ? t("removeConfirm", { name: labelOf(dialog.passkey) }) : ""
        }
        actionLabel={t("remove")}
        onAction={async () => {
          if (dialog.kind !== "remove") return;
          const id = String(dialog.passkey.id);
          const { error: refused } = await actions.deletePasskey({ id });
          const message = refused ? messageFor(refused, t("removeFailed")) : null;
          close();
          if (message) setError(message);
          else router.refresh();
        }}
      />
    </VStack>
  );
}
