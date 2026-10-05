import { agentCaddyAdminTransportWith, setCaddyAdminTransport } from "../caddy/admin";
import { createSimulatedCaddy } from "./simulated-caddy";

/** Call first at startup: the transport is the one seam all Caddy traffic passes. */
export function installDemoCaddy(): void {
  // Reached only with no agent attached - an operator unpaired the demo agent.
  const direct = createSimulatedCaddy();
  setCaddyAdminTransport(agentCaddyAdminTransportWith(async (request) => direct(request)));
}

export { startSimulatedAgent } from "./simulated-agent";
