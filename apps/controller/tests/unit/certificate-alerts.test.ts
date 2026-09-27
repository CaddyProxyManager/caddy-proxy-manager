import { describe, expect, it } from 'bun:test';
import {
  alertStage,
  certificateAlertsDue,
  type ExpiryCandidate,
  planCertificateAlerts,
} from '@/src/lib/email/certificate-alerts';
import { renderBody } from '@/src/lib/email/messages';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-27T12:00:00Z');

function candidate(
  key: string,
  daysLeft: number,
  options: { managed?: boolean; lifetimeDays?: number; agentId?: string } = {},
): ExpiryCandidate {
  const notAfter = NOW + daysLeft * DAY;
  const lifetime = (options.lifetimeDays ?? 90) * DAY;
  return {
    key,
    agentId: options.agentId ?? null,
    managed: options.managed ?? false,
    notBefore: new Date(notAfter - lifetime).toISOString(),
    item: { name: key, notAfter: new Date(notAfter).toISOString(), source: { kind: 'imported' } },
  };
}

describe('alertStage', () => {
  it('reports an imported certificate once inside the threshold', () => {
    expect(alertStage(candidate('a', 20), 14, NOW)).toBeNull();
    expect(alertStage(candidate('a', 10), 14, NOW)).toBe('expiring');
    expect(alertStage(candidate('a', -1), 14, NOW)).toBe('expired');
  });

  it('waits on a managed certificate until Caddy is well past renewing it', () => {
    // Ten days left of ninety is inside the threshold but not the last quarter: Caddy renews at 30.
    expect(alertStage(candidate('m', 25, { managed: true }), 14, NOW)).toBeNull();
    expect(alertStage(candidate('m', 10, { managed: true }), 14, NOW)).toBe('expiring');
  });

  it('never reports a healthy short-lived internal certificate', () => {
    // 12-hour lifetime, 8 hours left: under any threshold in days, still early in its life.
    const internal = candidate('i', 8 / 24, { managed: true, lifetimeDays: 0.5 });
    expect(alertStage(internal, 14, NOW)).toBeNull();
    expect(alertStage(candidate('i', 1 / 24, { managed: true, lifetimeDays: 0.5 }), 14, NOW)).toBe(
      'expiring',
    );
  });
});

describe('planCertificateAlerts', () => {
  it('sends each certificate once per stage', () => {
    const first = planCertificateAlerts([candidate('a', 10)], {}, new Set(), 14, NOW);
    expect(first.toSend.map((c) => c.key)).toEqual(['a']);

    const again = planCertificateAlerts([candidate('a', 9)], first.alerted, new Set(), 14, NOW);
    expect(again.toSend).toEqual([]);

    const expired = planCertificateAlerts([candidate('a', -1)], again.alerted, new Set(), 14, NOW);
    expect(expired.toSend.map((c) => c.key)).toEqual(['a']);
    expect(expired.alerted).toEqual({ a: 'expired' });
  });

  it('forgets a certificate that left the window, so a renewed one is not remembered', () => {
    const plan = planCertificateAlerts([candidate('a', 60)], { a: 'expiring' }, new Set(), 14, NOW);
    expect(plan.alerted).toEqual({});
  });

  it("keeps an unanswering agent's entries rather than repeat them next pass", () => {
    const previous = { 'agent:one:ab': 'expiring', 'agent:two:cd': 'expiring' } as const;
    const plan = planCertificateAlerts([], previous, new Set(['one']), 14, NOW);
    expect(plan.alerted).toEqual({ 'agent:one:ab': 'expiring' });
  });
});

describe('certificateAlertsDue', () => {
  it('runs at most twice a day', () => {
    expect(certificateAlertsDue(null, NOW)).toBe(true);
    expect(certificateAlertsDue(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe(false);
    expect(certificateAlertsDue(new Date(NOW - 13 * 60 * 60_000).toISOString(), NOW)).toBe(true);
  });
});

describe('renderBody', () => {
  it('escapes everything it puts in the HTML part', () => {
    const { html, text } = renderBody({
      paragraphs: ['<script>alert(1)</script>'],
      items: ['a & b'],
      action: { label: 'Go "now"', url: 'https://cpm.example.com/x?a=1&b=2' },
      footer: "Sent by O'Brien",
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('href="https://cpm.example.com/x?a=1&amp;b=2"');
    expect(html).toContain('O&#39;Brien');
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('https://cpm.example.com/x?a=1&b=2');
  });
});
