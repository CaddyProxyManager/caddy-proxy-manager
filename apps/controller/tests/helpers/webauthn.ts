/**
 * A software authenticator for the passkey routes: packed "none" attestations and ES256 assertions,
 * built by hand so a test controls every flag (UP, UV) the server is meant to check.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [key: string]: Cbor };

function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
  throw new Error('CBOR value too long for this encoder');
}

/** Just what COSE keys and attestation objects use: ints, text, bytes and maps. */
export function cbor(value: Cbor): Uint8Array {
  if (typeof value === 'number') {
    return Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return Uint8Array.from([...head(3, bytes.length), ...bytes]);
  }
  if (value instanceof Uint8Array) return Uint8Array.from([...head(2, value.length), ...value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  const parts = entries.flatMap(([key, entry]) => [...cbor(key), ...cbor(entry)]);
  return Uint8Array.from([...head(5, entries.length), ...parts]);
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export type SoftwareCredential = { id: Buffer; privateKey: KeyObject; cosePublicKey: Uint8Array };

export function newCredential(): SoftwareCredential {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coordinate = (value: string | undefined) => Buffer.from(value ?? '', 'base64url');
  const cosePublicKey = cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, coordinate(jwk.x)],
      [-3, coordinate(jwk.y)],
    ]),
  );
  return { id: randomBytes(16), privateKey, cosePublicKey };
}

function authenticatorData(
  rpId: string,
  flags: number,
  counter: number,
  attested?: SoftwareCredential,
): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  const parts: Uint8Array[] = [sha256(rpId), Buffer.from([flags]), count];
  if (attested) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(attested.id.length);
    parts.push(Buffer.alloc(16), length, attested.id, Buffer.from(attested.cosePublicKey));
  }
  return Buffer.concat(parts);
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export function registrationResponse(
  credential: SoftwareCredential,
  options: { challenge: string; origin: string; rpId: string; userVerified: boolean },
) {
  const flags = FLAG_UP | FLAG_AT | (options.userVerified ? FLAG_UV : 0);
  const attestationObject = cbor({
    fmt: 'none',
    attStmt: {},
    authData: authenticatorData(options.rpId, flags, 0, credential),
  });
  return {
    id: b64url(credential.id),
    rawId: b64url(credential.id),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(clientData('webauthn.create', options.challenge, options.origin)),
      attestationObject: b64url(attestationObject),
      transports: ['internal'],
    },
  };
}

export function authenticationResponse(
  credential: SoftwareCredential,
  options: {
    challenge: string;
    origin: string;
    rpId: string;
    userVerified: boolean;
    counter: number;
  },
) {
  const data = authenticatorData(
    options.rpId,
    FLAG_UP | (options.userVerified ? FLAG_UV : 0),
    options.counter,
  );
  const client = clientData('webauthn.get', options.challenge, options.origin);
  const signature = sign('sha256', Buffer.concat([data, sha256(client)]), credential.privateKey);
  return {
    id: b64url(credential.id),
    rawId: b64url(credential.id),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(client),
      authenticatorData: b64url(data),
      signature: b64url(signature),
    },
  };
}
