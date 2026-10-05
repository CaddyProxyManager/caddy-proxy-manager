/** CSV export of chart buckets and top lists, and the user-agent families the lists rank. */
import { describe, expect, it } from 'bun:test';
import { csvCell, csvFileName, toCsv } from '@/src/app/(dashboard)/analytics/explore/csv';
import { userAgentFamily } from '@/src/lib/analytics/user-agent';

describe('csv', () => {
  it('quotes a cell holding a comma, quote or line break', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('keeps a client-sent value a spreadsheet would run as a formula as text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@sum')).toBe("'@sum");
  });

  it('writes numbers as they are and nothing for an empty cell', () => {
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('joins rows with CRLF under a header', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, 'x'],
          [2, null],
        ],
      ),
    ).toBe('a,b\r\n1,x\r\n2,');
  });

  it('names files safely', () => {
    expect(csvFileName('analytics', 'User agents')).toBe('analytics-user-agents.csv');
    expect(csvFileName('../')).toBe('analytics.csv');
  });
});

describe('userAgentFamily', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0',
      'Edge',
    ],
    [
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      'Chrome',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox'],
    ['Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.2 Mobile/15E148 Safari/604.1', 'Safari'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
    ['curl/8.11.1', 'curl'],
    ['python-requests/2.32', 'Python'],
    ['Mozilla/5.0 zgrab/0.x', 'Other'],
    ['SomeCrawler/1.0 (+bot)', 'Other bot'],
  ])('%s is %s', (ua, family) => {
    expect(userAgentFamily(ua)).toBe(family);
  });

  it('has no family for no user agent', () => {
    expect(userAgentFamily('')).toBe('');
  });
});
