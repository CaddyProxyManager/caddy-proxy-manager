/**
 * Module gating must never drop a value from a submission: the `*Present` markers make the parser
 * always write, and an absent field reads as "empty", silently erasing tuned rules. Gating locks
 * the *enable* switch and keeps every value-carrying input mounted.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(moduleDir, '../..', relative), 'utf-8');

const geoBlockFields = read('src/components/proxy-hosts/GeoBlockFields.tsx');
const wafFields = read('src/components/proxy-hosts/WafFields.tsx');
const wafEventsClient = read('src/app/(dashboard)/waf/WafEventsClient.tsx');
const proxyHostActions = read('src/lib/proxy-host-form.ts');
const settingsActions = read('src/app/(dashboard)/settings/actions.ts');

describe('the parsers these components feed', () => {
  it('always runs once the presence marker is submitted', () => {
    // The parser cannot tell "cleared" from "not rendered".
    expect(proxyHostActions).toContain('if (!formData.has("geoblockPresent"))');
    expect(proxyHostActions).toContain('if (!formData.has("wafPresent")) return {};');
  });

  it('reads a missing rule list as empty rather than as unchanged', () => {
    expect(proxyHostActions).toMatch(/const rawExcl = formData\.get\("wafExcludedRuleIds"\)/);
    expect(proxyHostActions).toMatch(/excluded_rule_ids: number\[\] = rawExcl[\s\S]{0,200}: \[\];/);
  });
});

describe('GeoBlockFields', () => {
  it('submits the presence marker unconditionally', () => {
    expect(geoBlockFields).toContain('name="geoblockPresent"');
  });

  it('does not unmount the rule editors when the module is disabled', () => {
    // `&& !moduleDisabledReason` here would erase every stored rule on the next save.
    expect(geoBlockFields).not.toMatch(/\{enabled && !moduleDisabledReason && \(/);
    expect(geoBlockFields).toMatch(/\{enabled && \(/);
  });

  it('still locks the enable switch and says why', () => {
    // The safe half of gating.
    expect(geoBlockFields).toMatch(/isDisabled=\{Boolean\(moduleDisabledReason\)\}/);
    expect(geoBlockFields).toContain('<ModuleGated feature="geoblock">');
  });
});

describe('WafFields', () => {
  it('submits the presence marker unconditionally', () => {
    expect(wafFields).toContain('name="wafPresent"');
  });

  it('does not unmount WafRuleExclusions when the module is disabled', () => {
    // Losing WafRuleExclusions' hidden input wipes the host's suppression list.
    expect(wafFields).not.toMatch(/\{enabled && !moduleDisabledReason && \(/);
    expect(wafFields).toContain('<WafRuleExclusions');
  });

  it('still locks the enable switch and says why', () => {
    expect(wafFields).toMatch(/isDisabled=\{Boolean\(moduleDisabledReason\)\}/);
    expect(wafFields).toContain('<ModuleGated feature="waf">');
  });
});

describe('global WAF settings form', () => {
  it('reads a missing directives field as an empty string', () => {
    // Which is why the editor below must keep submitting even when gated.
    expect(settingsActions).toMatch(
      /const customDirectives =[\s\S]{0,200}formData\.get\("wafCustomDirectives"\)[\s\S]{0,120}: "";/,
    );
  });

  it('gates the directives editor read-only, never disabled', () => {
    // isDisabled drops CodeEditor's hidden input, fatal where absent means "empty"; isReadOnly
    // still submits.
    const editorBlock = wafEventsClient.slice(
      wafEventsClient.indexOf('htmlName="wafCustomDirectives"'),
    );
    const props = editorBlock.slice(0, editorBlock.indexOf('/>'));
    expect(props).toContain('isReadOnly={Boolean(wafModuleDisabledReason)}');
    expect(props).not.toContain('isDisabled=');
  });
});

describe('CodeEditor form contract', () => {
  it('omits its hidden input only when disabled, never when read-only', () => {
    // If this changes, every gated editor needs revisiting.
    const codeEditor = read('src/components/ui/CodeEditor.tsx');
    expect(codeEditor).toContain('{htmlName && !isDisabled && <input type="hidden"');
  });
});
