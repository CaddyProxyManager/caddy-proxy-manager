/**
 * `next-intl` in the demos (astro.config.mjs alias). The components use only its client hooks,
 * which `use-intl` provides without a Next runtime. `IntlProvider` is `NextIntlClientProvider`.
 */
export {
  IntlProvider,
  useFormatter,
  useLocale,
  useNow,
  useTimeZone,
  useTranslations,
} from "use-intl";
