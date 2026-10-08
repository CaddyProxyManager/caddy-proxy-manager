import type { IncomingMessage, Server } from "node:http";

/**
 * vinext's Node adapter drops the socket, so the compiled server stamps the peer here first,
 * overwriting any client-sent copy.
 */
export const PEER_ADDRESS_HEADER = "x-cpm-peer-address";

const STAMPED = Symbol.for("cpm.peer-address-stamped");

type Emit = (this: Server, event: string | symbol, ...args: unknown[]) => boolean;

export function installPeerAddressStamp(serverClass: typeof Server): void {
  const emit = serverClass.prototype.emit as Emit;
  const stamped: Emit = function (event, ...args) {
    if (event === "request") {
      const req = args[0] as IncomingMessage;
      req.headers[PEER_ADDRESS_HEADER] = req.socket?.remoteAddress ?? "";
    }
    return emit.call(this, event, ...args);
  };
  serverClass.prototype.emit = stamped as Server["emit"];
  (globalThis as Record<symbol, unknown>)[STAMPED] = true;
}

/** False under `vite dev`/`vinext start`, where nothing overwrites a client-sent copy of the header. */
export function isPeerAddressStamped(): boolean {
  return (globalThis as Record<symbol, unknown>)[STAMPED] === true;
}
