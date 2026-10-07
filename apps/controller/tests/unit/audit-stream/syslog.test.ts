/**
 * RFC 5424 formatting and the two framings: octet counting for TCP and TLS, and one datagram per
 * message for UDP, cut to the sink's maximum without losing the chain fields.
 */
import { describe, expect, it } from 'bun:test';
import { type AuditRecord, type SecurityRecord, gapRecord } from '@/src/lib/audit-stream/records';
import {
  escapeParamValue,
  formatDatagram,
  formatSyslog,
  octetFrame,
  SD_ID,
  syslogHostname,
} from '@/src/lib/audit-stream/syslog';

const HASH = 'a'.repeat(64);
const PREV = 'b'.repeat(64);

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    v: 1,
    kind: 'audit',
    seq: 42,
    prevHash: PREV,
    hash: HASH,
    actorId: 7,
    action: 'update',
    entityType: 'proxy_host',
    entityId: 3,
    summary: 'Updated proxy host shop',
    data: null,
    createdAt: '2026-10-06T12:00:00.000Z',
    ...overrides,
  };
}

/** Splits an RFC 5424 line into its header fields, structured data and MSG. */
function parse(message: string) {
  const match =
    /^<(\d+)>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*")*\])(?: (.*))?$/s.exec(
      message,
    );
  if (!match) throw new Error(`not RFC 5424: ${message}`);
  const [, pri, timestamp, host, app, procId, msgId, sd, msg] = match;
  const params: Record<string, string> = {};
  for (const param of sd.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
    params[param[1]] = param[2].replace(/\\(["\\\]])/g, '$1');
  }
  return { pri: Number(pri), timestamp, host, app, procId, msgId, sd, params, msg };
}

describe('RFC 5424 formatting', () => {
  it('writes the header, the chain fields as structured data, and the record as MSG', () => {
    const line = formatSyslog(audit(), 'controller-1');
    const parsed = parse(line);
    // Facility 13 (log audit), severity 5 (notice).
    expect(parsed.pri).toBe(13 * 8 + 5);
    expect(parsed.timestamp).toBe('2026-10-06T12:00:00.000Z');
    expect(parsed.host).toBe('controller-1');
    expect(parsed.app).toBe('cpm');
    expect(parsed.procId).toBe('-');
    expect(parsed.msgId).toBe('audit');
    expect(parsed.sd.startsWith(`[${SD_ID} `)).toBe(true);
    expect(parsed.params).toEqual({ seq: '42', prevHash: PREV, hash: HASH });
    expect(JSON.parse(parsed.msg)).toEqual(audit());
  });

  it('escapes ", \\ and ] inside a parameter value and nothing else', () => {
    expect(escapeParamValue('a"b\\c]d[e=f')).toBe('a\\"b\\\\c\\]d[e=f');
    const gap = gapRecord('audit', 1, 2, '2026-10-06T12:00:00.000Z');
    const line = formatSyslog({ ...gap, stream: 'au"d\\i]t' as 'audit' }, 'h');
    expect(line).toContain('stream="au\\"d\\\\i\\]t"');
    expect(parse(line).params.stream).toBe('au"d\\i]t');
  });

  it('marks a security record as outside the chain', () => {
    const record: SecurityRecord = {
      v: 1,
      kind: 'security',
      seq: 9,
      chained: false,
      type: 'waf',
      createdAt: '2026-10-06T12:00:00.000Z',
      host: 'shop.example',
      clientIp: '203.0.113.9',
      countryCode: null,
      method: 'GET',
      uri: '/?q=1',
      ruleId: 942100,
      ruleMessage: 'SQL injection',
      severity: 'critical',
      blocked: true,
    };
    const parsed = parse(formatSyslog(record, 'h'));
    expect(parsed.msgId).toBe('security');
    expect(parsed.pri).toBe(13 * 8 + 4);
    expect(parsed.params).toEqual({ seq: '9', chained: 'false', type: 'waf' });
  });

  it('keeps the host name to printable ASCII', () => {
    expect(syslogHostname('web aé')).toBe('web-a-');
    expect(syslogHostname('')).toBe('-');
    expect(syslogHostname('x'.repeat(300))).toHaveLength(255);
  });
});

describe('octet-counted framing', () => {
  it('prefixes MSG-LEN in octets and a space', () => {
    const message = formatSyslog(audit({ summary: 'Updated proxy host café' }), 'h');
    const frame = octetFrame(message);
    const space = frame.indexOf(0x20);
    const length = Number(frame.subarray(0, space).toString('ascii'));
    expect(length).toBe(Buffer.byteLength(message, 'utf8'));
    expect(length).toBeGreaterThan(message.length);
    expect(frame.subarray(space + 1).toString('utf8')).toBe(message);
  });

  it('frames several messages back to back so a reader can split them', () => {
    const frames = Buffer.concat(
      [1, 2, 3].map((seq) => octetFrame(formatSyslog(audit({ seq }), 'h'))),
    );
    const seqs: number[] = [];
    for (let offset = 0; offset < frames.length; ) {
      const space = frames.indexOf(0x20, offset);
      const length = Number(frames.subarray(offset, space).toString('ascii'));
      const message = frames.subarray(space + 1, space + 1 + length).toString('utf8');
      seqs.push(Number(parse(message).params.seq));
      offset = space + 1 + length;
    }
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe('UDP datagrams', () => {
  it('sends a short record whole', () => {
    const datagram = formatDatagram(audit(), 2048, 'h');
    expect(datagram.toString('utf8')).toBe(formatSyslog(audit(), 'h'));
  });

  it('cuts a long record to the maximum and keeps seq, hash and prevHash', () => {
    const long = audit({ data: JSON.stringify({ note: 'é'.repeat(3000) }) });
    for (const max of [480, 1024, 2048]) {
      const datagram = formatDatagram(long, max, 'h');
      expect(datagram.length).toBeLessThanOrEqual(max);
      const text = datagram.toString('utf8');
      // A cut never splits a character: it decodes without a replacement character.
      expect(text.includes('�')).toBe(false);
      const parsed = parse(text);
      expect(parsed.params.seq).toBe('42');
      expect(parsed.params.hash).toBe(HASH);
      expect(parsed.params.prevHash).toBe(PREV);
      expect(Number(parsed.params.truncated)).toBe(Buffer.byteLength(JSON.stringify(long), 'utf8'));
      expect(JSON.stringify(long).startsWith(parsed.msg)).toBe(true);
    }
  });

  it('drops MSG entirely rather than the header when even that is too long', () => {
    const datagram = formatDatagram(audit({ data: 'x'.repeat(5000) }), 200, 'h');
    const parsed = parse(datagram.toString('utf8'));
    expect(parsed.params.hash).toBe(HASH);
    expect(parsed.msg).toBeUndefined();
  });
});
