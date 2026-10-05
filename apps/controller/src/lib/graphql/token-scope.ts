/**
 * Wraps each Query and Mutation resolver in the token-scope check, so a resolver added later is
 * closed to a narrowed token until `lib/api-tokens/requirements.ts` names it.
 */
import { ApiAuthError, TOKEN_SCOPE_REFUSED } from "../api/auth";
import { GRAPHQL_REQUIREMENTS, tokenAllows } from "../api-tokens/requirements";
import type { GraphQLContext } from "./context";

// biome-ignore lint/suspicious/noExplicitAny: resolvers differ in parent and argument types
type Resolver = (parent: any, args: any, context: GraphQLContext, info: any) => unknown;

export function withTokenScopes<T extends Record<string, Resolver>>(
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
        return await resolve(parent, args, context, info);
      },
    ]),
  ) as T;
}
