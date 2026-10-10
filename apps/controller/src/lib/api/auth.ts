import { type NextRequest, NextResponse } from "next/server";
import { mfaStandingForAccount, mustEnrollTwoFactor } from "../auth/two-factor/policy";
import { auth, checkSameOrigin } from "../auth";
import { validateToken } from "../models/api-tokens";
import { randomUUID } from "node:crypto";
import { ApiClientError } from "./errors";
import { ChangeSubmitted } from "../approvals/submitted";
import { CaddyApplyError } from "../caddy/apply-error";
import { DomainError, domainErrorMessage } from "../errors/domain-error";
import { type TokenScope, unflattenScope } from "../api-tokens/scope";
import { restRequirement, roleAllows, tokenAllows } from "../api-tokens/requirements";
import { type Access, accessFor, can } from "../users/permissions";

export class ApiAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiAuthError";
    this.status = status;
  }
}

/** English: what an API client reads. */
export const TOKEN_SCOPE_REFUSED = "This API token's scope does not allow this request";
export const ROLE_REFUSED = "This account's role does not allow this request";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export type ApiAuthResult = {
  userId: number;
  role: string;
  authMethod: "bearer" | "session";
  /** A session viewing as some groups; a token never is. */
  viewAsGroupIds?: number[];
  /** A token's; a session has none, and is limited by its role alone. */
  tokenScope?: TokenScope;
};

export async function authenticateApiRequest(request: NextRequest): Promise<ApiAuthResult> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const rawToken = authHeader.slice(7);
    if (!rawToken) {
      throw new ApiAuthError("Invalid Bearer token", 401);
    }

    const result = await validateToken(rawToken);
    if (!result) {
      throw new ApiAuthError("Invalid or expired API token", 401);
    }
    // The policy binds the owner, so a token is no way around it once the grace period ends.
    if ((await mfaStandingForAccount(result.user)).status === "required") {
      throw new ApiAuthError(domainErrorMessage("apiTokenOwnerNeedsSecondFactor"), 403);
    }

    return {
      userId: result.user.id,
      role: result.user.role,
      authMethod: "bearer",
      tokenScope: unflattenScope(result.token),
    };
  }

  const session = await auth();
  if (!session?.user?.id) {
    throw new ApiAuthError("Unauthorized", 401);
  }

  // Deny rather than default to "user".
  const role = session.user.role;
  if (!role) {
    throw new ApiAuthError("Session missing role claim", 401);
  }

  // /api/v1 and /api/graphql skip the proxy's gate, so the two-factor policy is enforced here too.
  if (await mustEnrollTwoFactor(session)) {
    throw new ApiAuthError(domainErrorMessage("twoFactorRequired"), 403);
  }

  return {
    userId: Number(session.user.id),
    role,
    authMethod: "session",
    viewAsGroupIds: session.viewAs?.groupIds,
  };
}

/**
 * Every REST route comes through here, so the role and a token's scope are both checked once, by
 * path (`lib/api-tokens/requirements.ts`). A path named nowhere is refused to everyone.
 */
export async function requireApiUser(
  request: NextRequest,
): Promise<ApiAuthResult & { access: Access }> {
  const result = await authenticateApiRequest(request);
  const requirement = restRequirement(request.nextUrl.pathname, request.method);

  const scope = result.tokenScope;
  if (scope && scope.kind !== "full" && !tokenAllows(scope, requirement)) {
    throw new ApiAuthError(TOKEN_SCOPE_REFUSED, 403);
  }

  const access = await accessFor(result.userId, result.role, result.viewAsGroupIds);
  if (!roleAllows((capability) => can(access, capability), requirement)) {
    throw new ApiAuthError(ROLE_REFUSED, 403);
  }

  // A bearer token cannot be ridden cross-site; a session cookie can.
  if (result.authMethod === "session") {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const csrfResponse = checkSameOrigin(request);
      if (csrfResponse) {
        throw new ApiAuthError("Forbidden", 403);
      }
    }
  }

  return { ...result, access };
}

export function apiErrorResponse(error: unknown): NextResponse {
  // Not a failure: the write waits for approval, under this id.
  if (error instanceof ChangeSubmitted) {
    return NextResponse.json(
      { status: "pending", changeRequestId: error.requestId, message: error.message },
      { status: 202 },
    );
  }
  if (error instanceof ApiAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ApiClientError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // A model error that names its 4xx is as safe to echo as an ApiClientError.
  if (error instanceof DomainError && error.status !== undefined) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  // Caddy, or the agent in front of it, cannot be reached: try again later, not a server fault.
  if (error instanceof CaddyApplyError && error.code === "CADDY_UNREACHABLE") {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
  }
  // Older models throw a plain "<resource> not found": keep the 404 without echoing the message.
  if (error instanceof Error && error.message.trim().toLowerCase().endsWith("not found")) {
    return NextResponse.json({ error: "Resource not found", code: "NOT_FOUND" }, { status: 404 });
  }
  const errorId = logUnexpectedApiError("Unhandled API error", error);
  // The code is for a dashboard caller, which words it in the reader's language.
  return NextResponse.json(
    { error: "Internal server error", code: "INTERNAL_ERROR", errorId },
    { status: 500 },
  );
}

/** Correlatable metadata only - never raw messages, bodies, URLs or stacks into shared logs. */
export function logUnexpectedApiError(context: string, error: unknown): string {
  const errorId = randomUUID();
  const rawType = error instanceof Error ? error.name : typeof error;
  const errorType = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType)
    ? rawType
    : error instanceof Error
      ? "Error"
      : "unknown";
  const safeDetails: Record<string, unknown> = {
    errorId,
    context,
    errorType,
  };
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code)) {
      safeDetails.code = code;
    } else if (typeof code === "number" && Number.isFinite(code)) {
      safeDetails.code = code;
    }
  }
  console.error("Unexpected API failure", safeDetails);
  return errorId;
}
