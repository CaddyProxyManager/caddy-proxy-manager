import { defineConfig } from "@eloqnt/cli";

export default defineConfig({
  srcPath: "./src",
  messages: {
    path: "./messages",
    locales: "infer",
    sourceLocale: "en",
    format: "json",
  },
  lint: {
    // Keys built at runtime, which static analysis cannot see; settings-messages.test.ts and
    // domain-error.test.ts cover them. Scoped, since orphan-message has caught real dead keys.
    overrides: [
      {
        keys: "settings.registry.*",
        rules: { "orphan-message": "off" },
      },
      {
        keys: "settings.validation.*",
        rules: { "orphan-message": "off" },
      },
      {
        keys: "settings.groups.*",
        rules: { "orphan-message": "off" },
      },
      {
        keys: "errors.*",
        rules: { "orphan-message": "off" },
      },
      {
        // Read through a translator passed as a parameter, in password-policy-message.ts.
        keys: "passwordPolicy.*",
        rules: { "orphan-message": "off" },
      },
    ],
  },
});
