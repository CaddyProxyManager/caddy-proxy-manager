/**
 * For a test of a write route with its models mocked and no database: the approval policy reads
 * as off, so the route calls its model as it did before change approvals existed. Spread over
 * the real module, since a name a mock leaves out would be a missing export.
 */
import { DEFAULT_APPROVAL_POLICY } from '../../src/lib/approvals/policy';

export async function approvalsOffMock() {
  const actual = await import('../../src/lib/approvals/kinds');
  return () => ({ ...actual, getApprovalPolicy: async () => DEFAULT_APPROVAL_POLICY });
}
