/**
 * Fixed, queryable shapes are real fields; configuration the models validate travels as `JSON`.
 * Mirroring it as input types would make the schema look like an authority it is not, and JSON
 * lets GraphQL and REST run the same validation on the same input.
 */

import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from "graphql";

/** For a JSON literal written inline in a query document. */
const MAX_LITERAL_DEPTH = 32;

function literalToJson(node: ValueNode, depth = 0): unknown {
  if (depth > MAX_LITERAL_DEPTH) {
    throw new GraphQLError("JSON literal nested too deeply", { nodes: node });
  }
  switch (node.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((field) => [field.name.value, literalToJson(field.value, depth + 1)]),
      );
    case Kind.LIST:
      return node.values.map((value) => literalToJson(value, depth + 1));
    case Kind.NULL:
      return null;
    default:
      // An enum or variable: guessing would accept a document meaning other than it appears.
      throw new GraphQLError(`Cannot represent ${node.kind} as JSON`, { nodes: node });
  }
}

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description:
    "An arbitrary JSON value. Used for configuration the model layer validates, rather than " +
    "restating those shapes in the schema where the two could drift apart.",
  serialize: (value) => value,
  parseValue: (value) => value,
  // Wrapped: GraphQL passes (node, variables), which would land in the depth counter.
  parseLiteral: (node) => literalToJson(node),
});

/** ISO 8601, as a string: this documents the format rather than converting anything. */
export const DateTimeScalar = new GraphQLScalarType<string, string>({
  name: "DateTime",
  description: "An ISO 8601 timestamp, e.g. 2026-09-08T12:00:00.000Z.",
  serialize: (value) => String(value),
  parseValue: (value) => {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new GraphQLError("DateTime must be an ISO 8601 string");
    }
    return value;
  },
  parseLiteral: (node) => {
    if (node.kind !== Kind.STRING || Number.isNaN(Date.parse(node.value))) {
      throw new GraphQLError("DateTime must be an ISO 8601 string", { nodes: node });
    }
    return node.value;
  },
});
