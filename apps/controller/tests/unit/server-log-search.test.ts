import { describe, expect, it } from 'bun:test';
import type { PowerSearchFilter } from '@astryxdesign/core/PowerSearch';
import { filterServerLog, type ServerLogRow } from '@/src/app/(dashboard)/server-log-search';

const request = (status: number, extra: Partial<ServerLogRow & { kind: 'traffic' }> = {}) =>
  ({
    kind: 'traffic',
    ts: 1000,
    status,
    method: 'GET',
    host: 'app.example.com',
    uri: '/',
    clientIp: '2001:db8::1',
    isBlocked: false,
    ...extra,
  }) as const;
const event = {
  kind: 'event',
  ts: 2000,
  summary: 'Applied settings',
  actor: 'Ada',
  entityType: 'settings',
} as const;
const rows: ServerLogRow[] = [request(200), request(404), request(502, { isBlocked: true }), event];

const types = (operator: string, value: string[]): PowerSearchFilter => ({
  field: 'type',
  operator,
  value: { type: 'enum_list', value },
});

describe('filterServerLog', () => {
  it('keeps everything with no tokens', () => {
    expect(filterServerLog(rows, [])).toHaveLength(4);
  });

  it('filters by type, including errors across 4xx and 5xx and server events', () => {
    expect(
      filterServerLog(rows, [types('isAnyOf', ['errors'])]).map((r) => r.ts && r.kind),
    ).toEqual(['traffic', 'traffic']);
    expect(filterServerLog(rows, [types('isAnyOf', ['serverEvents'])])).toEqual([event]);
    expect(filterServerLog(rows, [types('isNoneOf', ['requests'])])).toEqual([event]);
    expect(filterServerLog(rows, [types('isAnyOf', ['blocked'])])).toHaveLength(1);
  });

  it('filters by time either side', () => {
    const after: PowerSearchFilter = {
      field: 'time',
      operator: 'after',
      value: { type: 'date_absolute', unixSeconds: 1500 },
    };
    expect(filterServerLog(rows, [after])).toEqual([event]);
    expect(filterServerLog(rows, [{ ...after, operator: 'before' }])).toHaveLength(3);
  });

  it('requires every token to match', () => {
    const status: PowerSearchFilter = {
      field: 'status',
      operator: 'greaterThanOrEqual',
      value: { type: 'integer', value: 500 },
    };
    const ip: PowerSearchFilter = {
      field: 'clientIp',
      operator: 'startsWith',
      value: { type: 'string', value: '2001:DB8' },
    };
    expect(filterServerLog(rows, [status, ip])).toHaveLength(1);
    expect(filterServerLog(rows, [status, types('isAnyOf', ['serverEvents'])])).toEqual([]);
  });

  it('searches free text across a row', () => {
    const text = (value: string): PowerSearchFilter => ({
      field: 'text',
      operator: 'contains',
      value: { type: 'string', value },
    });
    expect(filterServerLog(rows, [text('ada')])).toEqual([event]);
    expect(filterServerLog(rows, [text('APP.example')])).toHaveLength(3);
  });
});
