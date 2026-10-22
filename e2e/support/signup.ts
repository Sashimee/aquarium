import type { Page } from '@playwright/test';

export const PASSWORD = 'a long enough passphrase 9';

interface SinkMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Identity {
  name: string;
  email: string;
}

let counter = 0;

export function newIdentity(label: string): Identity {
  counter += 1;
  const tag = `${label}${Date.now().toString(36)}${counter}`;
  return { name: `E2E ${label}`, email: `e2e-${tag}@bas.lu` };
}

// No test-runner imports here: tools/smoke loads this file under plain node.
export async function findVerificationLink(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/__e2e/outbox`);
  const all = (await res.json()) as SinkMessage[];
  const mail = all.find(
    (m) => m.to.toLowerCase() === email.toLowerCase() && /verify/i.test(m.subject),
  );
  return mail ? (/<(https?:\/\/[^>\s]+)>/.exec(mail.text)?.[1] ?? '') : '';
}

export async function signUpStatus(
  page: Page,
  origin: string,
  identity: Identity,
): Promise<{ ok: boolean; status: number }> {
  const res = await page.request.post('/api/auth/sign-up/email', {
    headers: { origin },
    data: { ...identity, password: PASSWORD, callbackURL: '/verify-email' },
  });
  return { ok: res.ok(), status: res.status() };
}
