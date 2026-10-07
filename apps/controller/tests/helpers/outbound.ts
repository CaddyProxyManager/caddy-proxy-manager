/**
 * For `vi.mock('@/src/lib/http/outbound', outboundViaGlobalFetch)`: the client hands each call to
 * whatever `globalThis.fetch` is at the time, so a suite stubbing that keeps working. Every other
 * export stays real, `OutboundError` included.
 */
import * as outbound from '@/src/lib/http/outbound';

export function outboundViaGlobalFetch() {
  return {
    ...outbound,
    outboundFetch: ((url, init) =>
      globalThis.fetch(url, init as RequestInit)) as outbound.OutboundFetch,
  };
}
