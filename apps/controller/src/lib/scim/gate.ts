/**
 * In the sign-in instance: /scim/v2 goes to SCIM's own instance (./auth.ts), so turning on the
 * plugin's interactive transactions changes nothing for sign-in, whose hooks read through CPM's
 * own connection and would not see rows a transaction has not committed. Under SQLite, 501.
 */
import type { BetterAuthPlugin } from "better-auth";
import { ScimError } from "./errors";
import { SCIM_PATH, scimResponse, scimSupported } from "./plugin";

export function scimGate(): BetterAuthPlugin {
  return {
    id: "cpm-scim-gate",
    async onRequest(request) {
      if (!new URL(request.url).pathname.includes(SCIM_PATH)) return;
      if (!scimSupported()) {
        return {
          response: scimResponse(
            new ScimError(501, "SCIM provisioning needs CPM to run on PostgreSQL"),
          ),
        };
      }
      const { getScimAuth } = await import("./auth");
      return { response: await (await getScimAuth()).handler(request) };
    },
  };
}
