/**
 * What an action that returns data answers with. A production build strips a thrown error's
 * message on its way to the browser, so a failure crosses as a value: `runAction()` on the
 * server (`run-action.ts`) builds it, `unwrap()` here turns it back into a throw on the client.
 */
export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** The data, or an Error carrying the server's already translated message. */
export function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) return result.data;
  throw new Error(result.error);
}
