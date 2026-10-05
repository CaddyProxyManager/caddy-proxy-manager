/** Resolver failures are redacted, as REST's always were. */
import { describe, expect, it } from 'bun:test';
import { GraphQLError } from 'graphql';
import { ApiAuthError } from '@/src/lib/api/auth';
import { ApiValidationError } from '@/src/lib/api/errors';
import { domainError } from '@/src/lib/errors/domain-error';
import { maskGraphQLError } from '@/src/lib/graphql/errors';

/** As graphql-js hands it over. */
function located(original: Error): GraphQLError {
  return new GraphQLError(original.message, { originalError: original, path: ['field'] });
}

describe('masking GraphQL errors', () => {
  it('replaces an unexpected error, keeping an id to find it in the log', () => {
    const masked = maskGraphQLError(
      located(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
      'Unexpected error.',
    ) as GraphQLError;

    expect(masked.message).toBe('Internal server error');
    expect(typeof masked.extensions.errorId).toBe('string');
    expect(masked.path).toEqual(['field']);
  });

  it('passes deliberate refusals through as written', () => {
    const refusals = [
      new ApiAuthError('Administrator privileges required', 403),
      new ApiValidationError('Token name must be 100 characters or fewer'),
      domainError('cannotDeleteOwnAccount'),
      new GraphQLError('That agent is not connected.'),
    ];
    for (const original of refusals) {
      expect(maskGraphQLError(located(original), 'x').message).toBe(original.message);
    }
  });

  it('keeps an error graphql-js wrote itself, such as a syntax error', () => {
    const syntax = new GraphQLError('Syntax Error: Expected Name, found <EOF>.');
    expect(maskGraphQLError(syntax, 'x')).toBe(syntax);
  });

  it('reads a legacy "not found" message the way REST does, without echoing it', () => {
    expect(maskGraphQLError(located(new Error('Widget 12 not found')), 'x').message).toBe(
      'Resource not found',
    );
  });
});
