/**
 * describeWafRejection: reading Caddy's /load error for a WAF Coraza would not build. The bodies
 * are the ones Caddy 2 with coraza-caddy gave for two registry plugins that pass the static checks.
 */
import { describe, it, expect } from 'bun:test';
import { describeWafRejection } from '../../../src/lib/caddy/apply-error';

const PREFIX =
  'loading new config: loading http app module: provision http: server srv0: setting up route handlers: route 0: loading handler modules: position 0: loading module \'waf\': provision http.handlers.waf: invalid WAF config from string: failed to compile the directive "secrule": ';

describe('describeWafRejection', () => {
  it('reads the rule id Coraza quotes', () => {
    const body = JSON.stringify({
      error: `${PREFIX}invalid actions for rule with operator: "TX:GOOGLE-OAUTH2-PLUGIN_CALLBACK_DETECTED \\"@eq 1\\" \\"id:9505120,phase:2,pass,t:none,nolog,chain"`,
    });
    expect(describeWafRejection(body)).toEqual({ wafFailed: true, ruleIds: [9505120] });
  });

  it('knows the WAF failed even when no id is quoted', () => {
    const body = JSON.stringify({
      error: `${PREFIX}attempting to select a value inside a non-selectable collection: IP`,
    });
    expect(describeWafRejection(body)).toEqual({ wafFailed: true, ruleIds: [] });
  });

  it('leaves a refusal that is not the WAF alone', () => {
    const body = JSON.stringify({ error: 'loading new config: loading tls app module: bad cert' });
    expect(describeWafRejection(body)).toEqual({ wafFailed: false, ruleIds: [] });
  });
});
