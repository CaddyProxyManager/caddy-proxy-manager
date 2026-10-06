"use client";

/**
 * The signed-in user's API tokens. Each is created with a scope that narrows the owner's role
 * (lib/api-tokens/scope.ts); the secret is shown once, here, and only its hash is kept.
 */
import { type ReactNode, useState } from "react";
import { Key, Plus, Trash2 } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { ApiToken } from "@/lib/models/api-tokens";
import {
  DEFAULT_TOKEN_EXPIRY,
  TOKEN_EXPIRY_PRESETS,
  type TokenExpiryPreset,
} from "@/src/lib/api-tokens/expiry";
import {
  TOKEN_AREAS,
  type TokenArea,
  type TokenPermission,
  type TokenScopeKind,
} from "@/src/lib/api-tokens/scope";
import { createApiTokenAction, deleteApiTokenAction } from "../api-tokens/actions";
import { ProfileSection } from "./ProfileSection";

/** Mirrors MAX_TOKENS_PER_USER, which the model enforces; this only greys the button. */
const TOKEN_LIMIT = 10;

type AreaLevel = "none" | "read" | "write";

const EXPIRY_KEYS: Record<TokenExpiryPreset, "days30" | "days90" | "year1" | "never" | "custom"> = {
  "30d": "days30",
  "90d": "days90",
  "1y": "year1",
  never: "never",
  custom: "custom",
};

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && new Date(expiresAt) <= new Date();
}

export function ApiTokensSection({
  tokens,
  formatDate,
  withUtc,
  onError,
  onCreated,
}: {
  tokens: ApiToken[];
  formatDate: (iso: string | null) => string;
  withUtc: (iso: string | null, line: ReactNode) => ReactNode;
  onError: (message: string | null) => void;
  onCreated: () => void;
}) {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const atLimit = tokens.length >= TOKEN_LIMIT;

  const scopeLabel = (token: ApiToken) =>
    token.scope === "custom"
      ? t("apiTokenScope.customCount", { count: token.permissions.length })
      : t(`apiTokenScope.${token.scope}`);

  return (
    <ProfileSection
      icon={Key}
      title={t("apiTokens")}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus />}
          label={tCommon("create")}
          isDisabled={atLimit}
          tooltip={atLimit ? t("apiTokenLimit", { max: TOKEN_LIMIT }) : undefined}
          onClick={() => setDialogOpen(true)}
        />
      }
    >
      <VStack gap={4}>
        <Text type="body" size="sm" color="secondary">
          {t("apiTokensDescription")}
        </Text>

        {newToken && (
          <VStack gap={2}>
            <Text type="body" size="sm" weight="semibold">
              {t("tokenCopyWarning")}
            </Text>
            <CodeBlock code={newToken} width="100%" />
          </VStack>
        )}

        {tokens.length > 0 ? (
          <List hasDividers>
            {tokens.map((token) => {
              const expired = isExpired(token.expiresAt);
              return (
                <ListItem
                  key={token.id}
                  startContent={<Icon icon={Key} size="sm" color="secondary" />}
                  label={token.name}
                  description={
                    <HStack gap={3} wrap="wrap" vAlign="center">
                      {withUtc(
                        token.createdAt,
                        <Text type="body" size="sm" color="secondary">
                          {t("createdOn", { date: formatDate(token.createdAt) })}
                        </Text>,
                      )}
                      {withUtc(
                        token.lastUsedAt,
                        <Text type="body" size="sm" color="secondary">
                          {t("used", { when: formatDate(token.lastUsedAt) })}
                        </Text>,
                      )}
                      {withUtc(
                        token.expiresAt,
                        <Text type="body" size="sm" color="secondary">
                          {token.expiresAt === null
                            ? t("apiTokenNeverExpires")
                            : expired
                              ? tCommon("expiredOn", { date: formatDate(token.expiresAt) })
                              : tCommon("expiresOn", { date: formatDate(token.expiresAt) })}
                        </Text>,
                      )}
                    </HStack>
                  }
                  endContent={
                    <HStack gap={2} vAlign="center">
                      <Token
                        size="sm"
                        color={token.scope === "full" ? "default" : "blue"}
                        label={scopeLabel(token)}
                        description={
                          token.scope === "custom"
                            ? token.permissions
                                .map((permission) => {
                                  const [area, access] = permission.split(":") as [
                                    TokenArea,
                                    "read" | "write",
                                  ];
                                  return t("apiTokenPermissionLine", {
                                    area: t(`apiTokenAreas.${area}`),
                                    access: t(`apiTokenAccess.${access}`),
                                  });
                                })
                                .join("; ")
                            : undefined
                        }
                      />
                      {expired && <Badge variant="error" label={t("expired")} />}
                      <form action={deleteApiTokenAction.bind(null, token.id)}>
                        <IconButton
                          type="submit"
                          variant="ghost"
                          size="sm"
                          label={t("deleteTokenNamed", { name: token.name })}
                          tooltip={t("deleteToken")}
                          icon={<Trash2 />}
                        />
                      </form>
                    </HStack>
                  }
                />
              );
            })}
          </List>
        ) : (
          !newToken && (
            <EmptyState
              icon={<Key />}
              title={t("noApiTokensYet")}
              description={t("tokensEmptyDescription")}
              isCompact
            />
          )
        )}

        <Text type="supporting" color="secondary">
          {t("apiTokenCount", { count: tokens.length, max: TOKEN_LIMIT })}
        </Text>
      </VStack>

      {dialogOpen && (
        <CreateTokenDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(raw) => {
            setDialogOpen(false);
            setNewToken(raw);
            onError(null);
            onCreated();
          }}
        />
      )}
    </ProfileSection>
  );
}

/** Mounted only while open, so a cancelled form starts over next time. */
function CreateTokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (rawToken: string) => void;
}) {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<TokenExpiryPreset>(DEFAULT_TOKEN_EXPIRY);
  const [customDate, setCustomDate] = useState<ISODateTimeString | undefined>(undefined);
  const [scope, setScope] = useState<TokenScopeKind>("full");
  const [levels, setLevels] = useState<Record<TokenArea, AreaLevel>>(
    () =>
      Object.fromEntries(TOKEN_AREAS.map((area) => [area, "none"])) as Record<TokenArea, AreaLevel>,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const permissions = TOKEN_AREAS.flatMap((area): TokenPermission[] =>
    levels[area] === "none" ? [] : [`${area}:${levels[area]}` as TokenPermission],
  );
  const incomplete =
    !name.trim() ||
    (expiry === "custom" && !customDate) ||
    (scope === "custom" && permissions.length === 0);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await createApiTokenAction({
        name,
        expiry,
        expiresAt: customDate,
        scope,
        permissions,
      });
      if ("error" in result) setError(result.error);
      else onCreated(result.rawToken);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : t("apiTokenCreateFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t("createToken")}
      maxWidth="md"
      submitLabel={tCommon("create")}
      onSubmit={submit}
      isSubmitting={submitting}
      isSubmitDisabled={incomplete}
    >
      <VStack gap={4}>
        {error && <Banner status="error" title={error} />}
        <TextInput
          label={tCommon("name")}
          isRequired
          value={name}
          onChange={setName}
          placeholder={t("tokenNamePlaceholder")}
        />
        <Selector
          label={t("apiTokenExpiry.label")}
          value={expiry}
          onChange={(next) => setExpiry(next as TokenExpiryPreset)}
          options={TOKEN_EXPIRY_PRESETS.map((preset) => ({
            value: preset,
            label: t(`apiTokenExpiry.${EXPIRY_KEYS[preset]}`),
          }))}
        />
        {expiry === "custom" && (
          <DateTimeInput
            label={t("expiresAt")}
            isRequired
            value={customDate}
            onChange={setCustomDate}
          />
        )}
        <RadioList
          label={t("apiTokenScope.label")}
          description={t("apiTokenScope.help")}
          value={scope}
          onChange={(next) => setScope(next as TokenScopeKind)}
        >
          <RadioListItem
            value="full"
            label={t("apiTokenScope.full")}
            description={t("apiTokenScope.fullHelp")}
          />
          <RadioListItem
            value="read"
            label={t("apiTokenScope.read")}
            description={t("apiTokenScope.readHelp")}
          />
          <RadioListItem
            value="custom"
            label={t("apiTokenScope.custom")}
            description={t("apiTokenScope.customHelp")}
          />
        </RadioList>
        {scope === "custom" && (
          <List hasDividers>
            {TOKEN_AREAS.map((area) => (
              <ListItem
                key={area}
                label={t(`apiTokenAreas.${area}`)}
                endContent={
                  <SegmentedControl
                    label={t("apiTokenAreaAccess", { area: t(`apiTokenAreas.${area}`) })}
                    size="sm"
                    value={levels[area]}
                    onChange={(next) =>
                      setLevels((current) => ({ ...current, [area]: next as AreaLevel }))
                    }
                  >
                    <SegmentedControlItem value="none" label={t("apiTokenAccess.none")} />
                    <SegmentedControlItem value="read" label={t("apiTokenAccess.read")} />
                    <SegmentedControlItem value="write" label={t("apiTokenAccess.write")} />
                  </SegmentedControl>
                }
              />
            ))}
          </List>
        )}
      </VStack>
    </AppDialog>
  );
}
