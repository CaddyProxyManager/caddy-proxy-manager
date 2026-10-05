/**
 * Once per page render, through vinext's request scope; never across requests, and never in a
 * server action, where a read after the action's write must see it.
 */
import { describe, expect, it } from 'bun:test';
import { createRequestContext, runWithRequestContext } from 'vinext/shims/unified-request-context';
import { forgetRequestMemo, requestMemo } from '@/src/lib/request-memo';

function counter() {
  let calls = 0;
  return { load: async () => ++calls, calls: () => calls };
}

const inRequest = <T>(phase: string, run: () => Promise<T>) =>
  runWithRequestContext(createRequestContext({ phase } as never), run);

describe('requestMemo', () => {
  it('reads once per render', async () => {
    const c = counter();
    await inRequest('render', async () => {
      expect(await requestMemo('k', c.load)).toBe(1);
      expect(await requestMemo('k', c.load)).toBe(1);
    });
    await inRequest('render', async () => {
      expect(await requestMemo('k', c.load)).toBe(2);
    });
    expect(c.calls()).toBe(2);
  });

  it('reads every time in an action, and outside a request', async () => {
    const c = counter();
    await inRequest('action', async () => {
      await requestMemo('k', c.load);
      await requestMemo('k', c.load);
    });
    await requestMemo('k', c.load);
    expect(c.calls()).toBe(3);
  });

  it('forgets by prefix, and never keeps a failure', async () => {
    const c = counter();
    await inRequest('render', async () => {
      await requestMemo('setting:a', c.load);
      forgetRequestMemo('setting:');
      expect(await requestMemo('setting:a', c.load)).toBe(2);
      await expect(requestMemo('bad', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
      expect(await requestMemo('bad', async () => 'ok')).toBe('ok');
    });
  });
});
