"use client";

import { useState } from "react";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason, useModuleEnabled } from "@/components/caddy-modules/ModuleGate";
import {
  AUTOFILL_NEW_PASSWORD,
  AUTOFILL_OFF,
  NO_SPELLCHECK,
} from "@/components/ui/native-input-attrs";
import { FormCard, InfoAlert, StatusAlert } from "@/src/components/ui/FormLayout";
import {
  CACHE_STORAGE_MODULE_IDS,
  CACHE_STORAGES,
  type CacheStorage,
  CDN_PROVIDERS,
  CDN_STRATEGIES,
  type CdnProvider,
  type CdnStrategy,
  type HttpCacheSettingsView,
  MAX_OTTER_SIZE,
  MAX_REDIS_DB,
  MIN_OTTER_SIZE,
} from "@/src/lib/http-cache-options";

export function HttpCacheSection({
  httpCache,
  state,
  formAction,
}: {
  httpCache: HttpCacheSettingsView;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.httpCache");
  const cacheDisabledReason = useDisabledReason("cache");
  const [storage, setStorage] = useState<CacheStorage>(httpCache.storage);
  const [otterSize, setOtterSize] = useState<number | null>(httpCache.otterSize);
  const [redisAddresses, setRedisAddresses] = useState(httpCache.redis.addresses.join("\n"));
  const [redisUsername, setRedisUsername] = useState(httpCache.redis.username);
  const [redisPassword, setRedisPassword] = useState("");
  const [redisDb, setRedisDb] = useState<number | null>(httpCache.redis.db);
  const [etcdEndpoints, setEtcdEndpoints] = useState(httpCache.etcd.endpoints.join("\n"));
  const [provider, setProvider] = useState<CdnProvider>(httpCache.cdn.provider);
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState(httpCache.cdn.email);
  const [zoneId, setZoneId] = useState(httpCache.cdn.zoneId);
  const [serviceId, setServiceId] = useState(httpCache.cdn.serviceId);
  const [strategy, setStrategy] = useState<CdnStrategy>(httpCache.cdn.strategy);

  // Selected is enough to choose it: the rebuild that compiles it in follows the save.
  const selected = {
    otter: useModuleEnabled(CACHE_STORAGE_MODULE_IDS.otter),
    badger: useModuleEnabled(CACHE_STORAGE_MODULE_IDS.badger),
    simplefs: useModuleEnabled(CACHE_STORAGE_MODULE_IDS.simplefs),
    redis: useModuleEnabled(CACHE_STORAGE_MODULE_IDS.redis),
    etcd: useModuleEnabled(CACHE_STORAGE_MODULE_IDS.etcd),
  };
  const storageAvailable = (value: CacheStorage) => value === "memory" || selected[value];

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {cacheDisabledReason && (
            <InfoAlert title={t("moduleOffTitle")}>{cacheDisabledReason}</InfoAlert>
          )}
          <Selector
            label={t("storage")}
            htmlName="storage"
            description={t("storageHelp")}
            options={CACHE_STORAGES.map((value) => ({
              value,
              label: t(`storages.${value}.name`),
              description: storageAvailable(value)
                ? t(`storages.${value}.description`)
                : t("storageModuleOff"),
              // The stored choice stays selectable, so a save does not silently drop it.
              disabled: !storageAvailable(value) && value !== httpCache.storage,
            }))}
            value={storage}
            onChange={(value) => setStorage(value as CacheStorage)}
          />
          {storage !== "memory" && !storageAvailable(storage) && (
            <InfoAlert title={t("storageFallbackTitle")}>{t("storageModuleOff")}</InfoAlert>
          )}
          {storage === "otter" && (
            <NumberInput
              label={t("otterSize")}
              description={t("otterSizeHelp")}
              htmlName="otterSize"
              isOptional
              isIntegerOnly
              min={MIN_OTTER_SIZE}
              max={MAX_OTTER_SIZE}
              value={otterSize}
              onChange={setOtterSize}
            />
          )}
          {storage === "redis" && (
            <>
              <TextArea
                {...NO_SPELLCHECK}
                label={t("redisAddresses")}
                description={t("redisAddressesHelp")}
                htmlName="redisAddresses"
                placeholder="redis:6379"
                rows={2}
                value={redisAddresses}
                onChange={setRedisAddresses}
              />
              <TextInput
                {...AUTOFILL_OFF}
                label={t("redisUsername")}
                description={t("redisUsernameHelp")}
                htmlName="redisUsername"
                isOptional
                value={redisUsername}
                onChange={setRedisUsername}
              />
              <TextInput
                {...AUTOFILL_NEW_PASSWORD}
                label={t("redisPassword")}
                type="password"
                isOptional
                description={
                  httpCache.redis.hasPassword ? t("secretStored") : t("redisPasswordHelp")
                }
                htmlName="redisPassword"
                value={redisPassword}
                onChange={setRedisPassword}
              />
              <NumberInput
                label={t("redisDb")}
                htmlName="redisDb"
                isIntegerOnly
                min={0}
                max={MAX_REDIS_DB}
                value={redisDb}
                onChange={setRedisDb}
              />
            </>
          )}
          {storage === "etcd" && (
            <TextArea
              {...NO_SPELLCHECK}
              label={t("etcdEndpoints")}
              description={t("etcdEndpointsHelp")}
              htmlName="etcdEndpoints"
              placeholder="etcd:2379"
              rows={2}
              value={etcdEndpoints}
              onChange={setEtcdEndpoints}
            />
          )}

          <Selector
            label={t("cdnProvider")}
            htmlName="cdnProvider"
            description={t("cdnProviderHelp")}
            options={CDN_PROVIDERS.map((value) => ({ value, label: t(`cdnProviders.${value}`) }))}
            value={provider}
            onChange={(value) => setProvider(value as CdnProvider)}
          />
          {provider !== "none" && (
            <TextInput
              {...AUTOFILL_NEW_PASSWORD}
              label={t("cdnApiKey")}
              type="password"
              isOptional={httpCache.cdn.hasApiKey}
              description={
                httpCache.cdn.hasApiKey
                  ? t("secretStored")
                  : t(`cdnApiKeyHelp.${provider as Exclude<CdnProvider, "none">}`)
              }
              htmlName="cdnApiKey"
              value={apiKey}
              onChange={setApiKey}
            />
          )}
          {provider === "cloudflare" && (
            <>
              <TextInput
                {...AUTOFILL_OFF}
                label={t("cdnEmail")}
                description={t("cdnEmailHelp")}
                htmlName="cdnEmail"
                type="email"
                value={email}
                onChange={setEmail}
              />
              <TextInput
                {...AUTOFILL_OFF}
                label={t("cdnZoneId")}
                htmlName="cdnZoneId"
                value={zoneId}
                onChange={setZoneId}
              />
            </>
          )}
          {provider === "fastly" && (
            <>
              <TextInput
                {...AUTOFILL_OFF}
                label={t("cdnServiceId")}
                htmlName="cdnServiceId"
                value={serviceId}
                onChange={setServiceId}
              />
              <Selector
                label={t("cdnStrategy")}
                htmlName="cdnStrategy"
                description={t("cdnStrategyHelp")}
                options={CDN_STRATEGIES.map((value) => ({
                  value,
                  label: t(`cdnStrategies.${value}`),
                }))}
                value={strategy}
                onChange={(value) => setStrategy(value as CdnStrategy)}
              />
            </>
          )}
        </VStack>
      </form>
    </FormCard>
  );
}
