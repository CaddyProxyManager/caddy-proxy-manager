/**
 * The host ports the e2e L4 specs publish Caddy on: four in a row from E2E_L4_PORT_BASE (default
 * 15432), so a run can step around something else holding them. compose.ts hands the values to
 * Compose, which also forwards them to the agent that recreates Caddy.
 */
const raw = Number(process.env.E2E_L4_PORT_BASE || 15432);
if (!Number.isInteger(raw) || raw < 1024 || raw > 65532) {
  throw new Error(
    `E2E_L4_PORT_BASE must be a port from 1024 to 65532, not "${process.env.E2E_L4_PORT_BASE}"`,
  );
}

export const L4_TCP_PORT = raw;
export const L4_TCP_PORT_2 = raw + 1;
export const L4_TCP_PORT_3 = raw + 2;
export const L4_UDP_PORT = raw + 3;

/** What docker-compose.test.yml interpolates. */
export const L4_PORT_ENV = {
  E2E_L4_TCP_PORT: String(L4_TCP_PORT),
  E2E_L4_TCP_PORT_2: String(L4_TCP_PORT_2),
  E2E_L4_TCP_PORT_3: String(L4_TCP_PORT_3),
  E2E_L4_UDP_PORT: String(L4_UDP_PORT),
};
