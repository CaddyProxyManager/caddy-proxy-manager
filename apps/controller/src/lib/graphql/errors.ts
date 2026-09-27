/**
 * Masks like `apiErrorResponse`: reader-facing errors go out as written, anything else is logged
 * under an id and replaced, so internals never reach a caller.
 */

import { type DocumentNode, GraphQLError, visit } from "graphql";
import type { Plugin } from "graphql-yoga";
import { ApiAuthError, logUnexpectedApiError, NotFoundError } from "../api-auth";
import { ApiClientError } from "../api-errors";
import { DefaultResponseValidationError } from "../caddy-default-response";
import { DomainError } from "../domain-error";
import { ForbiddenError } from "../permissions";
import { SettingsApplyError } from "../settings-api";
import { SettingsValidationError } from "../settings-validation";
import type { GraphQLContext } from "./context";

const SAFE_ERRORS = [
  ApiAuthError,
  ApiClientError,
  DefaultResponseValidationError,
  DomainError,
  ForbiddenError,
  // A resolver throwing a GraphQLError is choosing its message, as the agent fields do.
  GraphQLError,
  NotFoundError,
  SettingsApplyError,
  SettingsValidationError,
];

export function maskGraphQLError(error: unknown, message: string): Error {
  if (!(error instanceof GraphQLError)) {
    const errorId = logUnexpectedApiError("Unhandled GraphQL error", error);
    return new GraphQLError(message, { extensions: { errorId } });
  }

  // No original error means graphql-js or Yoga wrote this one: a parse, validation or HTTP error.
  const original = error.originalError;
  if (!original || SAFE_ERRORS.some((type) => original instanceof type)) return error;

  const location = {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
  };
  // The same allowance apiErrorResponse makes for models that predate NotFoundError.
  if (original.message.trim().toLowerCase().endsWith("not found")) {
    return new GraphQLError("Resource not found", location);
  }
  const errorId = logUnexpectedApiError("Unhandled GraphQL error", original);
  return new GraphQLError("Internal server error", { ...location, extensions: { errorId } });
}

function selectsIntrospection(document: DocumentNode): boolean {
  let found = false;
  visit(document, {
    Field(node) {
      if (node.name.value === "__schema" || node.name.value === "__type") found = true;
    },
  });
  return found;
}

/** "Did you mean ...?" names real fields, which is what introspection is being withheld to hide. */
function withoutSuggestion(error: unknown): unknown {
  if (!(error instanceof GraphQLError)) return error;
  const message = error.message.replace(/\s*Did you mean [\s\S]*\?$/, "");
  if (message === error.message) return error;
  return new GraphQLError(message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    extensions: error.extensions,
  });
}

/** Authenticated callers only; the agent, the one caller without a user, never asks. */
export function authenticatedIntrospectionPlugin(): Plugin {
  return {
    async onExecute({ args, setResultAndStopExecution }) {
      if (!selectsIntrospection(args.document)) return;
      try {
        await (args.contextValue as unknown as GraphQLContext).viewer();
      } catch {
        setResultAndStopExecution({ errors: [new GraphQLError("Unauthorized")] });
      }
    },
    onValidate() {
      return ({ result, setResult }) => {
        if (result.length > 0) setResult(result.map(withoutSuggestion));
      };
    },
  };
}
