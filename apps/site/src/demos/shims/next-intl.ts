/**
 * `next-intl` in the demos (astro.config.mjs alias). The components use only its client hooks,
 * which `use-intl` provides without a Next runtime. `IntlProvider` is `NextIntlClientProvider`.
 * The two `create*` are core, for server modules the typecheck reaches through the controller.
 */
export {
  createFormatter,
  createTranslator,
  IntlProvider,
  useFormatter,
  useLocale,
  useNow,
  useTimeZone,
  useTranslations,
} from "use-intl";
