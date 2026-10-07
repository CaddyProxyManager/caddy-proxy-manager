/**
 * How a write got approved, stamped onto every audit event and host revision written inside it.
 * The models write their own events, two dozen of them, so a scope reaches them without each
 * growing a parameter.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type ApprovalStamp =
  | {
      /** Applied from a change request, as its requester, once approved or bypassed. */
      changeRequest: number;
      approvedBy: { id: number | null; name: string | null }[];
      bypass?: { by: number; reason: string };
    }
  /** A covered write an API token made while the policy leaves tokens out. */
  | { skipped: "apiToken" };

const storage = new AsyncLocalStorage<ApprovalStamp>();

export function withApprovalStamp<T>(stamp: ApprovalStamp, fn: () => Promise<T>): Promise<T> {
  return storage.run(stamp, fn);
}

export function currentApprovalStamp(): ApprovalStamp | undefined {
  return storage.getStore();
}
