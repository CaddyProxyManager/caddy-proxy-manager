/**
 * Summaries are stored in English and parsed back (src/lib/audit/summary.ts), with runtime keys
 * tsc cannot check. Each pattern must round-trip through its English catalog message.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import {
  AUDIT_SUMMARY_PATTERNS,
  auditSummaryText,
  matchAuditSummary,
} from '@/src/lib/audit/summary';

type Translator = Parameters<typeof auditSummaryText>[0];

const summaries = messages.auditLog.summaries as Record<string, string | undefined>;
const english = createTranslator({ locale: 'en', messages }) as unknown as Translator;
const render = english as unknown as (key: string, values?: Record<string, string>) => string;

function groupNames(pattern: RegExp): string[] {
  return [...pattern.source.matchAll(/\(\?<([A-Za-z]+)>/g)].map((match) => match[1] as string);
}

describe('auditLog.summaries messages', () => {
  it('has a message for every pattern', () => {
    const missing = AUDIT_SUMMARY_PATTERNS.filter(
      (candidate) => typeof summaries[candidate.message] !== 'string',
    ).map((candidate) => `${candidate.entityType}:${candidate.action} -> ${candidate.message}`);
    expect(missing).toEqual([]);
  });

  it('has no message that no pattern produces', () => {
    const used = new Set(AUDIT_SUMMARY_PATTERNS.map((candidate) => candidate.message));
    expect(Object.keys(summaries).filter((key) => !used.has(key))).toEqual([]);
  });

  it('reads every English message back into the values it was rendered with', () => {
    for (const candidate of AUDIT_SUMMARY_PATTERNS) {
      const values = Object.fromEntries(
        groupNames(candidate.pattern).map((name) => [name, `${name}-value`]),
      );
      const summary = render(`auditLog.summaries.${candidate.message}`, values);
      // The summary rides along so a failure names the sentence that did not match.
      expect({ summary, match: matchAuditSummary({ ...candidate, summary }) }).toEqual({
        summary,
        match: { message: candidate.message, values },
      });
    }
  });
});

describe('auditSummaryText', () => {
  it('renders English identical to what the call sites store', () => {
    const stored: Array<[entityType: string, action: string, summary: string]> = [
      ['proxy_host', 'create', 'Created proxy host app.example.com'],
      ['user', 'create', 'Created user 4 (sam@localhost) with role operator'],
      ['group', 'update', 'Updated the management grants for group 2'],
      [
        'user',
        'oidc_group_sync',
        'Group membership for user 4 synced from Dex: added to ops, dev; removed from legacy',
      ],
      ['user', 'oidc_role_sync', 'Role for user 4 set to "admin" from Dex groups (was "user")'],
      ['oauth_provider', 'oauth_provider_updated', 'Made OAuth provider "dex" primary'],
      ['user', 'password_removed', 'User removed their password; signs in with dex, github'],
    ];
    for (const [entityType, action, summary] of stored) {
      expect(auditSummaryText(english, { entityType, action, summary })).toBe(summary);
    }
  });

  it('shows a summary it does not recognise as it was stored', () => {
    const t = ((key: string) => `translated:${key}`) as unknown as Translator;
    // A shape no call site writes today, e.g. a row migrated from an older version.
    expect(
      auditSummaryText(t, {
        entityType: 'proxy_host',
        action: 'update',
        summary: 'Enabled the WAF on grafana.example.com',
      }),
    ).toBe('Enabled the WAF on grafana.example.com');
    // A known sentence under a different action is not assumed to mean the same.
    expect(
      auditSummaryText(t, {
        entityType: 'user',
        action: 'future_action',
        summary: 'User signed in',
      }),
    ).toBe('User signed in');
    expect(
      auditSummaryText(t, { entityType: 'session', action: 'login_success', summary: null }),
    ).toBeNull();
    expect(
      auditSummaryText(t, {
        entityType: 'session',
        action: 'login_success',
        summary: 'User signed in',
      }),
    ).toBe('translated:auditLog.summaries.loginSuccess');
  });
});
