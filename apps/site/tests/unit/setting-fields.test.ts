/**
 * The setup demo's `SETTING_FIELDS` is a hand copy (the registry won't bundle for a browser), so
 * this holds it to the registry, or the demo silently keeps an old form.
 */
import { expect, test } from "bun:test";
import { baseUrl, SETTING_DEFINITIONS } from "@cpm/controller/src/lib/settings/registry";
import { SETTING_FIELDS } from "../../src/demos/setup-simulation";

/** As app/setup/settings/page.tsx derives it, minus the translated text. */
function expected(definition: (typeof SETTING_DEFINITIONS)[number]) {
  return {
    key: definition.key,
    env: definition.env,
    group: definition.group,
    kind:
      typeof definition.default === "boolean"
        ? "boolean"
        : typeof definition.default === "number"
          ? "number"
          : definition.default === null
            ? "tristate"
            : "string",
    secret: definition.secret === true,
    generatable: definition.generatable === true,
    gate: definition.gate === true,
    composeReads: definition.composeReads === true,
  };
}

function actual(field: (typeof SETTING_FIELDS)[number]) {
  return {
    key: field.key,
    env: field.env,
    group: field.group,
    kind: field.kind,
    secret: field.secret === true,
    generatable: field.generatable === true,
    gate: field.gate === true,
    composeReads: field.composeReads === true,
  };
}

test("the demo lists every registry setting, in order, with the same shape", () => {
  expect(SETTING_FIELDS.map(actual)).toEqual(SETTING_DEFINITIONS.map(expected));
});

test("the demo opens each field on the value the settings step would", () => {
  const values = SETTING_FIELDS.map((field) => [field.key, field.value]);
  const defaults = SETTING_DEFINITIONS.map((definition) => [
    definition.key,
    // Gates as a fresh install acts (off), secrets blank, the public URL as the address reached.
    definition.gate
      ? false
      : definition.secret
        ? ""
        : definition.key === baseUrl.key
          ? "http://cpm.lan:3000"
          : definition.default,
  ]);
  expect(values).toEqual(defaults);
});
