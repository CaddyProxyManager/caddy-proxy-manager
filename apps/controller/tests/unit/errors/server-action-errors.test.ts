/**
 * A production build hands the browser a thrown action error without its message ("Minified
 * React error #441"), so no server action may let one escape: each body is one `runAction()`, or
 * one `try` whose `catch` lets
 * framework signals through and returns. Anything else fails here, before a person sees it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { localFunctions, serverActions } from '../../helpers/entry-points';
import { escapingThrow, wrapperEscapes } from '../../helpers/action-shape';

describe('server actions return their errors', () => {
  const actions = serverActions();

  it('finds the actions', () => {
    expect(actions.length).toBeGreaterThan(100);
  });

  it('lets no error escape to the client', () => {
    const escaping = actions.flatMap((action) => {
      const verdict = action.ownBody.trimStart().startsWith('{')
        ? escapingThrow(action.ownBody)
        : wrapperEscapes(action.ownBody, localFunctions(readFileSync(action.file, 'utf8')));
      return verdict ? [`${action.id}: ${verdict}`] : [];
    });
    expect(escaping).toEqual([]);
  });
});

describe('escapingThrow', () => {
  it('accepts one runAction() call', () => {
    expect(escapingThrow('{ return runAction(async () => { await x(); }); }')).toBeNull();
  });

  it('accepts a try whose catch returns', () => {
    expect(
      escapingThrow(
        '{ void _p; try { await x(); } catch (e) { unstable_rethrow(e); return actionError(t, e, f); } }',
      ),
    ).toBeNull();
  });

  it('refuses a check made before the try', () => {
    expect(
      escapingThrow('{ await requireCan("x"); try { a(); } catch { return b; } }'),
    ).not.toBeNull();
  });

  it('refuses a catch that would swallow a redirect', () => {
    expect(escapingThrow('{ try { a(); } catch (e) { return b; } }')).toBe(
      'the catch does not start with unstable_rethrow()',
    );
  });

  it('refuses a catch that throws', () => {
    expect(escapingThrow('{ try { a(); } catch (e) { throw e; } }')).toBe('the catch throws');
  });

  it('refuses code after runAction()', () => {
    expect(escapingThrow('{ return runAction(a); after(); }')).not.toBeNull();
  });

  it('ignores a throw inside a string or comment', () => {
    expect(
      escapingThrow(
        '{ try { a(); } catch (e) { unstable_rethrow(e); // throw\n return "throw }"; } }',
      ),
    ).toBeNull();
  });
});
