/**
 * The agent's only listener: `--pair` hands off to the running process, plus the healthcheck.
 * Unauthenticated on purpose: a Unix socket in the data volume is already that boundary.
 */

import {
  AGENT_LOCAL_ROUTES,
  type AgentLocalPairRequest,
  type AgentLocalPairResponse,
} from "@cpm/shared";
import type { AgentLifecycle } from "./lifecycle";
import { AGENT_VERSION } from "./status";

/** Three short fields; anything larger is not a pairing. */
const MAX_BODY_BYTES = 4 * 1024;

export function createLocalHandler(lifecycle: AgentLifecycle) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === AGENT_LOCAL_ROUTES.health) {
      const state = await lifecycle.localState();
      // 200 even idle: unhealthy while unpaired would have Docker restart it in a loop.
      return Response.json({ ok: true, version: AGENT_VERSION, lifecycle: state.lifecycle });
    }

    if (url.pathname === AGENT_LOCAL_ROUTES.state) {
      return Response.json(await lifecycle.localState());
    }

    if (url.pathname === AGENT_LOCAL_ROUTES.pairPreview) {
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST to preview a pairing." }, { status: 405 });
      }
      const parsed = await readPairBody(request);
      if (parsed instanceof Response) return parsed;
      return Response.json(
        await lifecycle.previewPair(parsed.host, parsed.port ?? null, parsed.code),
      );
    }

    if (url.pathname === AGENT_LOCAL_ROUTES.pair) {
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST to pair." }, { status: 405 });
      }
      return handlePair(request, lifecycle);
    }

    return Response.json({ error: "No such route." }, { status: 404 });
  };
}

async function readPairBody(request: Request): Promise<AgentLocalPairRequest | Response> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "That request is too large to be a pairing." }, { status: 413 });
  }

  let parsed: AgentLocalPairRequest;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as AgentLocalPairRequest;
  } catch {
    return Response.json({ error: "The request is not valid JSON." }, { status: 400 });
  }

  if (typeof parsed?.host !== "string" || typeof parsed?.code !== "string") {
    return Response.json({ error: "A pairing needs a host and a code." }, { status: 400 });
  }
  if (parsed.port !== undefined && parsed.port !== null && typeof parsed.port !== "number") {
    return Response.json({ error: "The port must be a number." }, { status: 400 });
  }
  return parsed;
}

async function handlePair(request: Request, lifecycle: AgentLifecycle): Promise<Response> {
  const parsed = await readPairBody(request);
  if (parsed instanceof Response) return parsed;

  const outcome = await lifecycle.pair(parsed.host, parsed.port ?? null, parsed.code);
  const body: AgentLocalPairResponse = {
    ok: outcome.ok,
    state: await lifecycle.localState(),
    ...(outcome.ok ? {} : { error: outcome.error }),
  };
  // 200 even when refused: the CLI reads `ok`, and a non-2xx would look like no agent at all.
  return Response.json(body);
}
