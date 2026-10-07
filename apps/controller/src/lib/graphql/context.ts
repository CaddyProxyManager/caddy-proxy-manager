/**
 * Auth via `authenticateApiRequest`, as REST does. **CSRF differs:** every GraphQL request is a
 * POST with the verb inside the document, so a session request is same-origin-checked always.
 */

import type { NextRequest } from "next/server";
import { type ApiAuthResult, ApiAuthError, authenticateApiRequest } from "../api/auth";
import { checkSameOrigin } from "../auth";
import { type Access, accessFor } from "../users/permissions";
import { type ApplyFailures, getApplyFailures } from "../caddy/apply-status";

export type GraphQLContext = {
  /** Authentication failures are per-field, not per-request. */
  viewer: () => Promise<ApiAuthResult>;
  access: () => Promise<Access>;
  /**
   * Exact bytes for the agent's signature, cloned by the route before the server reads the body -
   * a later clone throws "Body is disturbed or locked", and re-serialising changes the bytes.
   */
  rawBody: () => Promise<string>;
  request: NextRequest;
  /** Once per request, not once per agent in a list. Absent on a context a test builds. */
  applyFailures?: () => Promise<ApplyFailures>;
  /** A covered write was submitted for approval: the route answers 202. */
  markAccepted?: () => void;
};

/** Lazy, memoised auth: a malformed request pays nothing, and twenty fields authenticate once. */
export function createContext(
  request: NextRequest,
  rawBody: () => Promise<string>,
  accepted?: { value: boolean },
): GraphQLContext {
  let viewerPromise: Promise<ApiAuthResult> | null = null;
  let accessPromise: Promise<Access> | null = null;

  const viewer = () => {
    viewerPromise ??= (async () => {
      const result = await authenticateApiRequest(request);
      if (result.authMethod === "session" && checkSameOrigin(request)) {
        throw new ApiAuthError("Forbidden", 403);
      }
      return result;
    })();
    return viewerPromise;
  };

  const access = () => {
    accessPromise ??= (async () => {
      const result = await viewer();
      return await accessFor(result.userId, result.role, result.viewAsGroupIds);
    })();
    return accessPromise;
  };

  let failuresPromise: Promise<ApplyFailures> | null = null;
  const applyFailures = () => {
    failuresPromise ??= getApplyFailures();
    return failuresPromise;
  };

  const markAccepted = () => {
    if (accepted) accepted.value = true;
  };

  return { viewer, access, rawBody, request, applyFailures, markAccepted };
}

export async function requireUser(context: GraphQLContext): Promise<ApiAuthResult> {
  return await context.viewer();
}
