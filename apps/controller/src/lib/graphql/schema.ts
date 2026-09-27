/** Built once at module load: parsing SDL is not free and the schema never changes at runtime. */

import { createSchema } from "graphql-yoga";
import { agentResolvers } from "./agent";
import { resolvers } from "./resolvers";
import { typeDefs } from "./typedefs";

/** By hand: two sources overlapping only on `Mutation`, and it shows the agent adds mutations. */
export const schema = createSchema({
  typeDefs,
  resolvers: {
    ...resolvers,
    Mutation: { ...resolvers.Mutation, ...agentResolvers.Mutation },
    Subscription: agentResolvers.Subscription,
  },
});
