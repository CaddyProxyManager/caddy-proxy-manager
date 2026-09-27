/**
 * The whole API plus the agent subscription (why one schema: `src/lib/graphql/agent.ts`).
 * GraphiQL is dev-only and introspection needs auth, so production advertises no mutations.
 */

import { createYoga } from "graphql-yoga";
import type { NextRequest } from "next/server";
import { createContext } from "@/src/lib/graphql/context";
import { authenticatedIntrospectionPlugin, maskGraphQLError } from "@/src/lib/graphql/errors";
import { schema } from "@/src/lib/graphql/schema";

type ServerContext = { request: NextRequest; rawBody: () => Promise<string> };

const yoga = createYoga<ServerContext>({
  schema,
  graphqlEndpoint: "/api/graphql",
  // Next needs the fetch Response, not Yoga's own.
  fetchAPI: { Response },
  graphiql: process.env.NODE_ENV === "development",
  // Yoga's default reflects any Origin with credentials allowed.
  cors: false,
  plugins: [authenticatedIntrospectionPlugin()],
  context: ({ request, rawBody }) => createContext(request as NextRequest, rawBody),
  // Deliberate refusals go out as written, so "domain already in use" survives; anything else is
  // logged and replaced, as REST's apiErrorResponse does.
  maskedErrors: {
    maskError: maskGraphQLError,
  },
});

/**
 * Clones the body before Yoga reads it: the agent's signature covers its bytes, and a later clone
 * throws "Body is disturbed or locked" as a failed subscription. Read only if a resolver asks.
 */
function bodyReader(request: NextRequest): () => Promise<string> {
  const clone = request.clone();
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= clone.text().catch(() => "");
    return pending;
  };
}

async function handle(request: NextRequest) {
  return await yoga.handleRequest(request, { request, rawBody: bodyReader(request) });
}

export async function GET(request: NextRequest) {
  return await handle(request);
}

export async function POST(request: NextRequest) {
  return await handle(request);
}

export async function OPTIONS(request: NextRequest) {
  return await handle(request);
}
