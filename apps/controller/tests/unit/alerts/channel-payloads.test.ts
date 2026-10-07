/** Each channel's exact payload, from a batch built by hand so nothing but the builder is tested. */
import { describe, expect, it } from 'bun:test';
import { Webhook } from 'standardwebhooks';
import {
  DISCORD_COLOURS,
  DISCORD_LIMITS,
  discordPayload,
  discordRetryAfterMs,
  discordUrl,
} from '@/src/lib/alerts/channels/discord';
import { ntfyPayload, ntfyUrl } from '@/src/lib/alerts/channels/ntfy';
import { retryAfterHeaderMs } from '@/src/lib/alerts/channels/send';
import { SLACK_LIMITS, slackPayload } from '@/src/lib/alerts/channels/slack';
import { TEAMS_MAX_BYTES, teamsPayload, teamsSize } from '@/src/lib/alerts/channels/teams';
import {
  generateSigningSecret,
  messageId,
  signedHeaders,
  signingKey,
  webhookBody,
} from '@/src/lib/alerts/channels/webhook';
import { channelUrl, prepareChannel } from '@/src/lib/alerts/channels';
import type { AlertBatch, AlertItem } from '@/src/lib/alerts/message';
import type { AlertSeverity } from '@/src/lib/notifications/builtins';

function item(i: number, severity: AlertSeverity = 'warning', size = 40): AlertItem {
  return {
    id: i,
    kind: 'upstreamErrors',
    title: `Upstream errors on host-${i}.test`,
    text: `host-${i}.test answered 12 requests with 502. `.padEnd(size, 'x'),
    severity,
    resolved: false,
    at: '2026-09-29T12:00:00.000Z',
    time: 'Sep 29, 2026, 12:00 PM UTC',
    rule: 'Upstream errors',
    event: { kind: 'upstreamErrors', host: `host-${i}.test`, count: 12, minutes: 5 },
  };
}

function batch(items: AlertItem[]): AlertBatch {
  return {
    subject: `Caddy Proxy Manager: ${items.length} notifications`,
    appName: 'Caddy Proxy Manager',
    url: 'https://cpm.example.com',
    items,
    labels: {
      severity: 'Severity',
      rule: 'Rule',
      time: 'When',
      open: 'Open the dashboard',
      severities: { critical: 'Critical', warning: 'Warning', info: 'Info', resolved: 'Resolved' },
      more: (count) => `…and ${count} more`,
    },
  };
}

describe('Discord', () => {
  it('sends one embed per alert, coloured by severity as an integer', () => {
    const payload = discordPayload(
      batch([item(1, 'critical'), item(2, 'info'), { ...item(3), resolved: true }]),
    );
    expect(payload.embeds.map((embed) => embed.color)).toEqual([
      DISCORD_COLOURS.critical,
      DISCORD_COLOURS.info,
      DISCORD_COLOURS.resolved,
    ]);
    expect(Number.isInteger(payload.embeds[0].color)).toBe(true);
    expect(payload.embeds[0]).toMatchObject({
      title: 'Upstream errors on host-1.test',
      timestamp: '2026-09-29T12:00:00.000Z',
      fields: [
        { name: 'Severity', value: 'Critical', inline: true },
        { name: 'When', value: 'Sep 29, 2026, 12:00 PM UTC', inline: true },
        { name: 'Rule', value: 'Upstream errors', inline: true },
      ],
    });
    expect(payload.content).toBe('Caddy Proxy Manager: 3 notifications');
  });

  it('keeps to 10 embeds, 25 fields, 2000 characters of content and 6000 across embeds', () => {
    const many = discordPayload(batch(Array.from({ length: 12 }, (_, i) => item(i))));
    expect(many.embeds).toHaveLength(DISCORD_LIMITS.embeds);
    expect(many.content).toContain('…and 2 more');

    const long = discordPayload(
      batch(Array.from({ length: 10 }, (_, i) => item(i, 'warning', 3000))),
    );
    const total = long.embeds.reduce(
      (sum, embed) =>
        sum +
        embed.title.length +
        embed.description.length +
        embed.footer.text.length +
        embed.fields.reduce((n, field) => n + field.name.length + field.value.length, 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.total);
    expect(long.embeds.length).toBeLessThan(10);
    expect(long.content).toContain(`…and ${10 - long.embeds.length} more`);
    for (const embed of long.embeds) {
      expect(embed.fields.length).toBeLessThanOrEqual(DISCORD_LIMITS.fields);
      expect(embed.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    }

    const huge = discordPayload(batch([item(1, 'warning', 9000)]));
    expect(huge.embeds).toHaveLength(1);
    expect(huge.embeds[0].description.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);

    const wordy = batch([item(1)]);
    wordy.subject = 's'.repeat(2500);
    expect(discordPayload(wordy).content.length).toBe(DISCORD_LIMITS.content);
  });

  it('posts with ?wait=true, keeping a thread id', () => {
    expect(discordUrl('https://discord.com/api/webhooks/1/abc')).toBe(
      'https://discord.com/api/webhooks/1/abc?wait=true',
    );
    expect(discordUrl('https://discord.com/api/webhooks/1/abc?thread_id=9')).toBe(
      'https://discord.com/api/webhooks/1/abc?thread_id=9&wait=true',
    );
  });

  it('waits the float retry_after from the body, not the rounded header', () => {
    expect(
      discordRetryAfterMs('{"message":"You are being rate limited.","retry_after":0.347}'),
    ).toBe(347);
    expect(discordRetryAfterMs('not json')).toBeNull();
    expect(retryAfterHeaderMs('2')).toBe(2000);
    expect(
      retryAfterHeaderMs('Tue, 29 Sep 2026 12:00:05 GMT', Date.parse('2026-09-29T12:00:00Z')),
    ).toBe(5000);
  });
});

describe('Slack', () => {
  it('always carries text as the fallback beside the blocks', () => {
    const payload = slackPayload(batch([item(1), item(2)]));
    expect(payload.text).toContain('Caddy Proxy Manager: 2 notifications');
    expect(payload.text).toContain('host-2.test answered 12 requests with 502.');
    expect(payload.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'Caddy Proxy Manager: 2 notifications' },
    });
    expect(payload.blocks.at(-1)).toMatchObject({ type: 'actions' });
  });

  it('keeps to 50 blocks and says what was left out', () => {
    const payload = slackPayload(batch(Array.from({ length: 40 }, (_, i) => item(i))));
    expect(payload.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    expect(JSON.stringify(payload.blocks)).toContain('more');
    expect(payload.text.length).toBeGreaterThan(0);
  });

  it('escapes what Slack reads as markup', () => {
    const payload = slackPayload(batch([{ ...item(1), title: '<b>&' }]));
    expect(JSON.stringify(payload.blocks[1])).toContain('&lt;b&gt;&amp;');
  });
});

describe('Teams', () => {
  it('sends an Adaptive Card 1.2 attachment', () => {
    const payload = teamsPayload(batch([item(1, 'critical')]));
    expect(payload.type).toBe('message');
    const [attachment] = payload.attachments;
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content).toMatchObject({ type: 'AdaptiveCard', version: '1.2' });
    expect(attachment.content.body[1]).toMatchObject({ color: 'Attention', weight: 'Bolder' });
    expect(attachment.content.actions[0]).toEqual({
      type: 'Action.OpenUrl',
      title: 'Open the dashboard',
      url: 'https://cpm.example.com',
    });
  });

  it('stays under 28 KB however much it is given', () => {
    const payload = teamsPayload(
      batch(Array.from({ length: 50 }, (_, i) => item(i, 'warning', 1900))),
    );
    expect(teamsSize(payload)).toBeLessThan(TEAMS_MAX_BYTES);
    expect(JSON.stringify(payload)).toContain('more');
  });
});

describe('ntfy', () => {
  it('posts JSON to the server root with the topic, an integer priority and tags as an array', () => {
    const payload = ntfyPayload(batch([item(1, 'info'), item(2, 'critical')]), 'cpm-alerts');
    expect(payload).toMatchObject({
      topic: 'cpm-alerts',
      title: 'Caddy Proxy Manager: 2 notifications',
      priority: 5,
      tags: ['rotating_light'],
      click: 'https://cpm.example.com',
    });
    expect(Number.isInteger(payload.priority)).toBe(true);
    expect(ntfyPayload(batch([{ ...item(1), resolved: true }]), 't').priority).toBe(2);
    expect(ntfyUrl('https://ntfy.example.com/sub/path')).toBe('https://ntfy.example.com/');
  });

  it('sends its token as a Bearer header', async () => {
    const { channelRequest } = await import('@/src/lib/alerts/channels');
    const prepared = prepareChannel(
      {
        name: 'phone',
        kind: 'ntfy',
        server: 'https://ntfy.example.com',
        topic: 'cpm',
        token: 'tk_abc',
      },
      null,
    );
    const { parseChannel } = await import('@/src/lib/alerts/channels');
    const channel = parseChannel({
      id: 1,
      builtin: null,
      failures: 0,
      retryAt: null,
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
      lastErrorCode: null,
      createdAt: '',
      updatedAt: '',
      ...prepared,
    });
    const request = channelRequest(channel, batch([item(1)]), [1], Date.now());
    expect(request.url).toBe('https://ntfy.example.com/');
    expect(request.headers).toEqual({ authorization: 'Bearer tk_abc' });
    expect(JSON.parse(request.body).topic).toBe('cpm');
  });
});

describe('generic webhook', () => {
  const secret = generateSigningSecret();
  const key = signingKey(secret)!;
  const body = JSON.stringify(webhookBody(batch([item(1)]), Date.now()));

  it('is signed so an off-the-shelf Standard Webhooks verifier accepts it', () => {
    const headers = signedHeaders(key, messageId([1, 2]), Date.now(), body, []);
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(String(Number(headers['webhook-timestamp']))).toBe(headers['webhook-timestamp']);
    expect(new Webhook(secret).verify(body, headers)).toMatchObject({ type: 'alerts' });
  });

  it('fails a stale timestamp, a tampered timestamp and a tampered body', () => {
    const verifier = new Webhook(secret);
    const stale = signedHeaders(key, 'msg_1', Date.now() - 10 * 60_000, body, []);
    expect(() => verifier.verify(body, stale)).toThrow();
    const fresh = signedHeaders(key, 'msg_1', Date.now(), body, []);
    const moved = { ...fresh, 'webhook-timestamp': String(Number(fresh['webhook-timestamp']) + 1) };
    expect(() => verifier.verify(body, moved)).toThrow();
    expect(() => verifier.verify(`${body} `, fresh)).toThrow();
  });

  it('keeps the id across retries of the same deliveries, so a replay is detectable', () => {
    expect(messageId([3, 1, 2])).toBe(messageId([1, 2, 3]));
    expect(messageId([1, 2])).not.toBe(messageId([1, 2, 3]));
    const seen = new Set<string>();
    const receive = (headers: Record<string, string>) => {
      new Webhook(secret).verify(body, headers);
      const id = headers['webhook-id'];
      const replay = seen.has(id);
      seen.add(id);
      return replay;
    };
    expect(receive(signedHeaders(key, messageId([7]), Date.now(), body, []))).toBe(false);
    expect(receive(signedHeaders(key, messageId([7]), Date.now() + 1_000, body, []))).toBe(true);
  });

  it('adds custom headers but never over the signature or the content type', () => {
    const headers = signedHeaders(key, 'msg_1', Date.now(), body, [
      { name: 'X-Token', value: 'abc' },
      { name: 'Webhook-Signature', value: 'forged' },
    ]);
    expect(headers['X-Token']).toBe('abc');
    expect(headers['Webhook-Signature']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  it('refuses a malformed signing secret and reserved or duplicate headers', () => {
    expect(signingKey('whsec_short')).toBeNull();
    expect(signingKey('nope')).toBeNull();
    expect(() =>
      prepareChannel(
        { name: 'w', kind: 'webhook', url: 'https://hooks.example.com/x', signingSecret: 'bad' },
        null,
      ),
    ).toThrow();
    expect(() =>
      prepareChannel(
        {
          name: 'w',
          kind: 'webhook',
          url: 'https://hooks.example.com/x',
          headers: [{ name: 'webhook-id', value: 'x' }],
        },
        null,
      ),
    ).toThrow();
    const made = prepareChannel(
      { name: 'w', kind: 'webhook', url: 'https://hooks.example.com/x' },
      null,
    );
    expect(made.generatedSecret).toMatch(/^whsec_/);
  });
});

describe('channel addresses', () => {
  it('allows queries, refuses metadata and plain http off this network', () => {
    expect(channelUrl('https://example.logic.azure.com/workflows/1?api-version=1&sig=x')).toContain(
      'sig=x',
    );
    expect(() => channelUrl('http://169.254.169.254/latest')).toThrow();
    expect(() => channelUrl('http://hooks.example.com/x')).toThrow();
    expect(channelUrl('http://192.168.1.20:8080/hook')).toBe('http://192.168.1.20:8080/hook');
    expect(() => channelUrl('http://192.168.1.20/hook', { https: true })).toThrow();
    expect(() => channelUrl('https://user:pw@hooks.example.com/')).toThrow();
  });
});
