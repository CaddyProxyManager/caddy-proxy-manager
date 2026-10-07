/** Roles over GraphQL: the same store and guards the Roles page uses. */

import { NotFoundError } from "../api/auth";
import { setGroupRole } from "../models/groups";
import { CAPABILITIES } from "../roles/capabilities";
import {
  type RoleInput,
  createRole,
  deleteRole,
  getRole,
  listRoles,
  updateRole,
} from "../roles/store";
import type { GraphQLContext } from "./context";

async function actor(context: GraphQLContext) {
  const [{ userId, role }, { capabilities }] = await Promise.all([
    context.viewer(),
    context.access(),
  ]);
  return { userId, role, capabilities };
}

export const roleQueryResolvers = {
  roles: async () => await listRoles(),
  role: async (_: unknown, args: { key: string }) => await getRole(args.key),
  capabilities: async () => [...CAPABILITIES],
};

export const roleMutationResolvers = {
  createRole: async (_: unknown, args: { input: RoleInput }, context: GraphQLContext) =>
    await createRole(args.input, await actor(context)),
  updateRole: async (
    _: unknown,
    args: { key: string; input: RoleInput },
    context: GraphQLContext,
  ) => await updateRole(args.key, args.input, await actor(context)),
  deleteRole: async (_: unknown, args: { key: string }, context: GraphQLContext) => {
    await deleteRole(args.key, await actor(context));
    return true;
  },
  setGroupRole: async (
    _: unknown,
    args: { groupId: number; role?: string | null },
    context: GraphQLContext,
  ) => {
    const group = await setGroupRole(args.groupId, args.role ?? null, await actor(context)).catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "groupNotFound") {
          throw new NotFoundError("Group not found");
        }
        throw error;
      },
    );
    return group;
  },
};
