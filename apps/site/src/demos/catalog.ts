import { createTranslator } from "use-intl";
// Named, so the bundle carries these namespaces and not the whole catalog. A namespace a demo
// starts using must be added here; tests/unit/demo-messages.test.ts fails until it is.
import {
  accessLists,
  agents,
  analytics,
  attention,
  auditLog,
  auth,
  caddyModules,
  certificates,
  common,
  errors,
  groups,
  hostHistory,
  hostReview,
  l4ProxyHosts,
  logs,
  nav,
  overview,
  passwordPolicy,
  profile,
  proxyHosts,
  settings,
  setup,
  ui,
  users,
  waf,
} from "@cpm/controller/messages/en.json";

/** The English catalog, as far as the demos read it. */
export const messages = {
  accessLists,
  agents,
  analytics,
  attention,
  auditLog,
  auth,
  caddyModules,
  certificates,
  common,
  errors,
  groups,
  hostHistory,
  hostReview,
  l4ProxyHosts,
  logs,
  nav,
  overview,
  passwordPolicy,
  profile,
  proxyHosts,
  settings,
  setup,
  ui,
  users,
  waf,
};

export const DEMO_NAMESPACES = Object.keys(messages);

/** The English catalog outside a component, for shims answering in the product's words. */
export const t = createTranslator({ locale: "en", messages });
