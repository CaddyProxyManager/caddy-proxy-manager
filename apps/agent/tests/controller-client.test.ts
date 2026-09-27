/**
 * GraphQL `errors` to the status codes the lifecycle reasons in: a 401 flattened loops forever
 * on a dead secret, and anything else raised to 401 throws away a working pairing.
 */
import { createHmac } from "node:crypto";
import { describe, it, expect, afterEach } from "bun:test";
import {
  AGENT_NONCE_HEADER,
  AGENT_NONCE_PATTERN,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  CONTROLLER_AGENT_ROUTES,
  signatureBase,
} from "@cpm/shared";
import { ControllerClient, ControllerRejected } from "../src/controller-client";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function respondWith(payload: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function client() {
  return new ControllerClient("http://controller:3000", "agent-1");
}

const STATUS = {
  agentId: "agent-1",
  version: "test",
  mode: "standalone",
  composeProject: "cpm",
  l4Ports: { applied: [], status: { state: "idle" } },
  caddyBuild: { applied: null, status: { state: "idle" } },
  services: { applied: null, status: { state: "idle" } },
  analytics: { enabled: false, accessLogPresent: false },
} as never;

describe("a GraphQL refusal keeps the meaning the lifecycle acts on", () => {
  it("surfaces an unknown agent as 401, so the lifecycle can stop retrying", async () => {
    // The one code that ends the loop.
    respondWith({
      errors: [{ message: "Unknown agent", extensions: { code: "AGENT_UNAUTHORIZED" } }],
    });

    const error = await client()
      .postStatus("secret", STATUS)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ControllerRejected);
    expect((error as ControllerRejected).status).toBe(401);
    expect((error as ControllerRejected).message).toBe("Unknown agent");
  });

  it("keeps a not-connected refusal retryable", async () => {
    // A restarted controller has no subscription yet: reconnect, never unpair.
    respondWith({
      errors: [
        { message: "That agent is not connected.", extensions: { code: "AGENT_NOT_CONNECTED" } },
      ],
    });

    const error = await client()
      .postStatus("secret", STATUS)
      .catch((e: unknown) => e);

    expect((error as ControllerRejected).status).toBe(409);
  });

  it("treats an untagged error as retryable rather than as a lost pairing", async () => {
    // A fault the controller did not anticipate is not evidence that the secret is dead.
    respondWith({ errors: [{ message: "boom" }] });

    const error = await client()
      .postStatus("secret", STATUS)
      .catch((e: unknown) => e);

    expect((error as ControllerRejected).status).toBe(400);
  });

  it("does not treat a successful reply as a refusal", async () => {
    respondWith({ data: { agentStatus: true } });

    await expect(client().postStatus("secret", STATUS)).resolves.toBeUndefined();
  });
});

describe("command results are not capped at a status-sized body", () => {
  it("sends a result far larger than a status without complaint", async () => {
    // A config readback runs to megabytes, and one GraphQL endpoint shares one cap.
    let sentBytes = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentBytes = String(init?.body ?? "").length;
      return new Response(JSON.stringify({ data: { agentCommandResults: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await client().postResults("secret", [
      {
        id: "agent-1:1",
        ok: true,
        response: { status: 200, body: "x".repeat(2 * 1024 * 1024), headers: {} },
      },
    ] as never);

    expect(sentBytes).toBeGreaterThan(1024 * 1024);
  });

  it("sends nothing at all when there are no results", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await client().postResults("secret", []);

    expect(called).toBe(false);
  });
});

describe("signing", () => {
  it("signs a fresh nonce into every request, so the controller can refuse a replay", async () => {
    const sent: { headers: Headers; body: string }[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push({ headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ data: { agentStatus: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await client().postStatus("secret", STATUS);
    await client().postStatus("secret", STATUS);

    const [first, second] = sent;
    const nonce = first.headers.get(AGENT_NONCE_HEADER) ?? "";
    expect(nonce).toMatch(AGENT_NONCE_PATTERN);
    expect(second.headers.get(AGENT_NONCE_HEADER)).not.toBe(nonce);

    // Signed, or stripping the nonce would make the request replayable.
    const timestamp = Number(first.headers.get(AGENT_TIMESTAMP_HEADER));
    const bodyHash = new Bun.CryptoHasher("sha256").update(first.body).digest("hex");
    const expected = createHmac("sha256", "secret")
      .update(signatureBase("POST", CONTROLLER_AGENT_ROUTES.graphql, timestamp, bodyHash, nonce))
      .digest("hex");
    expect(first.headers.get(AGENT_SIGNATURE_HEADER)).toBe(expected);
  });
});
