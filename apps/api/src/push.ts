import { createECDH, createPrivateKey, sign, type KeyObject } from 'node:crypto';

export interface VapidKeys {
  publicKey: string;
  privateKey: KeyObject;
}

const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

const SEND_TIMEOUT_MS = 10_000;
const JWT_LIFETIME_S = 12 * 60 * 60;

// The server fetches whatever endpoint a client registers, so only the browser vendors' push
// services may be named; anything else would be a request-forgery primitive.
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function parseVapidKeys(publicKey: string, privateKey: string): VapidKeys {
  const bad = (what: string): never => {
    throw new Error(
      `VAPID keys invalid: ${what}. Generate a pair with the snippet in docs/deployment.md.`,
    );
  };
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey) || !/^[A-Za-z0-9_-]+$/.test(privateKey)) {
    bad('keys must be base64url');
  }
  const pub = Buffer.from(publicKey, 'base64url');
  const d = Buffer.from(privateKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 0x04) bad('public key must be an uncompressed P-256 point');
  if (d.length !== 32) bad('private key must be 32 bytes');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  if (!ecdh.getPublicKey().equals(pub)) bad('the public key does not belong to the private key');
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33).toString('base64url'),
      d: d.toString('base64url'),
    },
    format: 'jwk',
  });
  return { publicKey, privateKey: key };
}

export function vapidAuthorization(
  keys: VapidKeys,
  subject: string,
  audience: string,
  nowMs: number,
): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S,
    sub: subject,
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

export type PushResult = 'sent' | 'gone' | 'failed';

export interface PushSender {
  publicKey: string;
  /** Sends a payload-less push; the service worker shows a fixed reminder, so nothing about the tank leaves the server. */
  send(endpoint: string): Promise<PushResult>;
}

export function createPushSender(
  keys: VapidKeys,
  subject: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): PushSender {
  return {
    publicKey: keys.publicKey,
    async send(endpoint) {
      if (!isAllowedPushEndpoint(endpoint)) return 'gone';
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: {
            authorization: vapidAuthorization(keys, subject, new URL(endpoint).origin, now()),
            ttl: '86400',
            urgency: 'low',
            'content-length': '0',
          },
        });
        if (res.ok) return 'sent';
        return res.status === 404 || res.status === 410 ? 'gone' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}
