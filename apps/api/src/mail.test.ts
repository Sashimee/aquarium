import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { createMailer, escapeHtml, MailThrottledError } from './mail.ts';
import { memoryHitStore } from './rate-limit.ts';

const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'abcDEF0123456789_-'.repeat(18)}.sig`;
const URL_WITH_AMP = `https://devfish.bas.lu/api/auth/verify-email?token=${TOKEN}&callbackURL=%2Fverify-email`;

async function rawMessage(url: string): Promise<string> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
  const original = transport.sendMail.bind(transport);
  let raw = '';
  transport.sendMail = (async (data: Parameters<typeof original>[0]) => {
    const result = await original(data);
    raw = (result as unknown as { message: Buffer }).message.toString('utf8');
    return result;
  }) as typeof transport.sendMail;
  await createMailer(transport, 'fish@bas.lu').sendVerification('a@bas.lu', url);
  return raw;
}

function section(raw: string, type: 'text/plain' | 'text/html'): { head: string; body: string } {
  const found = raw.split(/\n--[^\n]+/).find((s) => s.includes(`Content-Type: ${type}`));
  if (!found) throw new Error(`no ${type} part in message`);
  const [head = '', ...rest] = found.trim().split('\n\n');
  return { head, body: rest.join('\n\n') };
}

function decodePart(raw: string, type: 'text/plain' | 'text/html'): string {
  const { head, body } = section(raw, type);
  if (!/Content-Transfer-Encoding: base64/i.test(head)) {
    throw new Error(`${type} part is not base64 encoded`);
  }
  return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
}

describe('verification mail', () => {
  it('is multipart with text and html parts', async () => {
    const raw = await rawMessage(URL_WITH_AMP);
    expect(raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain('Content-Type: text/html');
  });

  it('puts the exact URL alone on its own line in the text part', async () => {
    const text = decodePart(await rawMessage(URL_WITH_AMP), 'text/plain');
    expect(text.split('\n')).toContain(`<${URL_WITH_AMP}>`);
  });

  it('keeps a 300+ char URL with ampersands unbroken in the text part', async () => {
    expect(URL_WITH_AMP.length).toBeGreaterThan(300);
    const raw = await rawMessage(URL_WITH_AMP);
    expect(section(raw, 'text/plain').head).toMatch(/Content-Transfer-Encoding: base64/i);
    expect(decodePart(raw, 'text/plain')).toContain(`\n<${URL_WITH_AMP}>\n`);
  });

  it('html href unescapes to the exact URL, as button and as visible link', async () => {
    const html = decodePart(await rawMessage(URL_WITH_AMP), 'text/html');
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) {
      expect(href).not.toMatch(/&(?!amp;)/);
      expect(href.replace(/&amp;/g, '&')).toBe(URL_WITH_AMP);
    }
    expect(html).toContain('>Verify my email</a>');
    expect(html).toContain(`>${escapeHtml(URL_WITH_AMP)}</a>`);
  });

  it('escapes html metacharacters', () => {
    expect(escapeHtml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&#39;');
  });
});

describe('global mail cap', () => {
  it('does not use up a recipient budget while refusing under an exhausted cap', async () => {
    let now = 0;
    const sent: string[] = [];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (async (data: { to: string }) => {
      sent.push(data.to);
    }) as unknown as typeof transport.sendMail;
    const mailer = createMailer(transport, 'fish@bas.lu', {
      store: memoryHitStore(() => now),
      log: () => undefined,
      limits: {
        perRecipient: { max: 2, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 2, windowMs: 60_000 },
      },
    });
    await mailer.sendVerification('a@bas.lu', 'https://x.test/a');
    await mailer.sendVerification('b@bas.lu', 'https://x.test/b');
    for (let i = 0; i < 5; i++) {
      await expect(mailer.sendVerification('victim@bas.lu', 'https://x.test/v')).rejects.toThrow(
        MailThrottledError,
      );
    }
    now += 61_000;
    await mailer.sendVerification('victim@bas.lu', 'https://x.test/v');
    await mailer.sendPasswordReset('victim@bas.lu', 'https://x.test/v');
    expect(sent.filter((to) => to === 'victim@bas.lu')).toHaveLength(2);
  });
});
