/** SCIM connections over GraphQL: the same model and checks the page uses. */
import {
  type ScimConnectionInput,
  createScimConnection,
  deleteScimConnection,
  listScimConnections,
  rotateScimConnectionToken,
  updateScimConnection,
} from "../scim/connections";
import type { GraphQLContext } from "./context";

async function actor(context: GraphQLContext) {
  const [{ userId }, { capabilities }] = await Promise.all([context.viewer(), context.access()]);
  return { userId, capabilities };
}

export const scimQueryResolvers = {
  scimConnections: async () => await listScimConnections(),
};

export const scimMutationResolvers = {
  createScimConnection: async (
    _: unknown,
    args: { input: ScimConnectionInput },
    context: GraphQLContext,
  ) => await createScimConnection(args.input, await actor(context)),
  updateScimConnection: async (
    _: unknown,
    args: { id: number; input: ScimConnectionInput },
    context: GraphQLContext,
  ) => await updateScimConnection(args.id, args.input, await actor(context)),
  rotateScimConnectionToken: async (_: unknown, args: { id: number }, context: GraphQLContext) =>
    await rotateScimConnectionToken(args.id, await actor(context)),
  deleteScimConnection: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await deleteScimConnection(args.id, await actor(context));
    return true;
  },
};
