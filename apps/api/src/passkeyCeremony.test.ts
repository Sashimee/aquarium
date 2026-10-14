import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const RP_ID = new URL(APP_ORIGIN).hostname;
const headers = { 'content-type': 'application/json', origin: APP_ORIGIN };

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error(`CBOR length ${n} needs a wider head than this test encoder supports`);
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x ?? '', 'base64url');
    this.y = Buffer.from(jwk.y ?? '', 'base64url');
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: APP_ORIGIN, crossOrigin: false }));
  }

  private authData(flags: number, attested: Buffer): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    return Buffer.concat([sha256(RP_ID), Buffer.from([flags]), counter, attested]);
  }

  register(challenge: string) {
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    const authData = this.authData(
      0x45,
      Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey]),
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  assert(challenge: string) {
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const authenticatorData = this.authData(0x05, Buffer.alloc(0));
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), {
      key: this.privateKey,
    });
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
    };
  }
}

const cookieHeader = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

describe('passkey registration and sign-in with hashed identifiers', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function verifiedSession() {
    const email = `passkey-${Date.now()}-${randomBytes(3).toString('hex')}@bas.lu`;
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers,
      payload: { email, password: 'correct horse battery', name: 'Tester', callbackURL: '/' },
    });
    await h.settleMail();
    const text = h.outbox.find((m) => m.to === email)?.text ?? '';
    const link = /https?:\/\/\S+verify-email\?\S+/.exec(text)?.[0];
    if (!link) throw new Error('no verification link in mail');
    const url = new URL(link);
    const verified = await h.app.inject({ method: 'GET', url: url.pathname + url.search });
    return { email, cookie: cookieHeader(verified) };
  }

  async function register(cookie: string, authenticator: SoftwareAuthenticator) {
    const options = await h.app.inject({
      url: '/api/auth/passkey/generate-register-options',
      headers: { cookie },
    });
    expect(options.statusCode).toBe(200);
    const { challenge } = options.json<{ challenge: string }>();
    return h.app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-registration',
      headers: { ...headers, cookie: `${cookie}; ${cookieHeader(options)}` },
      payload: { response: authenticator.register(challenge), name: 'Software key' },
    });
  }

  it('registers a passkey, then signs in with it and gets a session', async () => {
    const { email, cookie } = await verifiedSession();
    expect(cookie).not.toBe('');
    const authenticator = new SoftwareAuthenticator();

    const registered = await register(cookie, authenticator);
    expect(registered.statusCode).toBe(200);
    const stored = await h.database.pool.query<{ credential_id: string }>(
      'select credential_id from passkey',
    );
    expect(stored.rows.map((r) => r.credential_id)).toContain(b64url(authenticator.credentialId));

    const options = await h.app.inject('/api/auth/passkey/generate-authenticate-options');
    expect(options.statusCode).toBe(200);
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-authentication',
      headers: { ...headers, cookie: cookieHeader(options) },
      payload: { response: authenticator.assert(options.json<{ challenge: string }>().challenge) },
    });
    expect(signedIn.statusCode).toBe(200);
    const sessionCookie = cookieHeader(signedIn);
    expect(sessionCookie).toContain('session_token');

    const session = await h.app.inject({
      url: '/api/auth/get-session',
      headers: { cookie: sessionCookie },
    });
    expect(session.json<{ user: { email: string } }>().user.email).toBe(email);
  });

  it('rejects an assertion for a challenge the server did not issue', async () => {
    const { cookie } = await verifiedSession();
    const authenticator = new SoftwareAuthenticator();
    expect((await register(cookie, authenticator)).statusCode).toBe(200);

    const options = await h.app.inject('/api/auth/passkey/generate-authenticate-options');
    expect(options.statusCode).toBe(200);
    const forged = await h.app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-authentication',
      headers: { ...headers, cookie: cookieHeader(options) },
      payload: { response: authenticator.assert(b64url(randomBytes(32))) },
    });
    expect(forged.statusCode).toBe(400);
    expect(cookieHeader(forged)).not.toContain('session_token');
  });
});
