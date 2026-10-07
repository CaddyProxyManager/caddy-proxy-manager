/**
 * Wraps each Query and Mutation resolver in the role and token-scope checks, so a resolver added
 * later is closed to everyone until `lib/api-tokens/requirements.ts` names what it needs.
 */
import { GraphQLError } from "graphql";
import { ApiAuthError, ROLE_REFUSED, TOKEN_SCOPE_REFUSED } from "../api/auth";
import { ChangeSubmitted } from "../approvals/submitted";
import { GRAPHQL_REQUIREMENTS, roleAllows, tokenAllows } from "../api-tokens/requirements";
import { can } from "../users/permissions";
import type { GraphQLContext } from "./context";

// biome-ignore lint/suspicious/noExplicitAny: resolvers differ in parent and argument types
type Resolver = (parent: any, args: any, context: GraphQLContext, info: any) => unknown;

export function withRequirements<T extends Record<string, Resolver>>(
  typeName: "Query" | "Mutation",
  fields: T,
): T {
  return Object.fromEntries(
    Object.entries(fields).map(([field, resolve]) => [
      field,
      async (parent: unknown, args: unknown, context: GraphQLContext, info: unknown) => {
        const viewer = await context.viewer();
        const requirement = GRAPHQL_REQUIREMENTS[`${typeName}.${field}`] ?? null;
        if (!tokenAllows(viewer.tokenScope, requirement)) {
          throw new ApiAuthError(TOKEN_SCOPE_REFUSED, 403);
        }
        const access = await context.access();
        if (!roleAllows((capability) => can(access, capability), requirement)) {
          throw new ApiAuthError(ROLE_REFUSED, 403);
        }
        try {
          return await resolve(parent, args, context, info);
        } catch (error) {
          if (!(error instanceof ChangeSubmitted)) throw error;
          // The route answers 202, as REST does; the id travels in the error's extensions.
          context.markAccepted?.();
          throw new GraphQLError(error.message, {
            extensions: { code: "PENDING_APPROVAL", changeRequestId: error.requestId },
          });
        }
      },
    ]),
  ) as T;
}
