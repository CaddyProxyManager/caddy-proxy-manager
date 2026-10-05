/** `agents.statusMessages.*` is keyed by the code an agent sends, so tsc cannot check it. */
import { describe, expect, it } from 'bun:test';
import { AGENT_STATUS_MESSAGES } from '@cpm/shared';
import { createTranslator } from 'next-intl';
import messages from '../../../messages/en.json';
import { agentStatusMessage } from '@/src/lib/agent/status-message';

type Translator = Parameters<typeof agentStatusMessage>[0];

const catalog = messages.agents.statusMessages as Record<string, string | undefined>;
const t = createTranslator({ locale: 'en', messages }) as unknown as Translator;

describe('agents.statusMessages', () => {
  it('has a message for every code an agent can send', () => {
    expect(AGENT_STATUS_MESSAGES.filter((code) => typeof catalog[code] !== 'string')).toEqual([]);
  });

  it('has no message for a code no agent sends', () => {
    const codes = new Set<string>(AGENT_STATUS_MESSAGES);
    expect(Object.keys(catalog).filter((code) => !codes.has(code))).toEqual([]);
  });

  it('words a known code in the catalog, not in the English the agent sent', () => {
    expect(
      agentStatusMessage(t, {
        message: 'Recreating Caddy with 2 published port(s).',
        messageCode: 'l4Applying',
        messageParams: { count: 2 },
      }),
    ).toBe('Recreating Caddy with 2 published ports.');
  });

  it("falls back to the agent's English without a code", () => {
    expect(agentStatusMessage(t, { message: 'From an older agent.' })).toBe('From an older agent.');
    expect(agentStatusMessage(t, {})).toBeNull();
  });

  it('names an image only when the agent knows it', () => {
    const loaded = (image: string) =>
      agentStatusMessage(t, {
        messageCode: 'imageLoaded',
        messageParams: { image, named: image ? 'yes' : 'no', count: 1 },
      });
    expect(loaded('cpm/caddy:1')).toBe('Loaded cpm/caddy:1 with 1 module.');
    expect(loaded('')).toBe('Loaded the image with 1 module.');
  });
});
