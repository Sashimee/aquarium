import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { createMailer, escapeHtml, ipBucket, MailThrottledError } from './mail.ts';
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

  it('tells the user to open the link in the same browser, in both parts', async () => {
    const raw = await rawMessage(URL_WITH_AMP);
    for (const type of ['text/plain', 'text/html'] as const) {
      const body = decodePart(raw, type);
      expect(body).toContain('Open the link in the same browser you signed up in.');
      expect(body).toContain('set one with Forgot password instead.');
    }
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

  it('logs the cap again after the window frees, including caps reached by charged requests', async () => {
    let now = 0;
    const logs: string[] = [];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (async () => undefined) as unknown as typeof transport.sendMail;
    const mailer = createMailer(transport, 'fish@bas.lu', {
      store: memoryHitStore(() => now),
      log: (m) => logs.push(m),
      limits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 2, windowMs: 60_000 },
      },
    });
    const capEvents = () => logs.filter((m) => m.includes('mail_global_cap_reached')).length;
    for (let round = 1; round <= 2; round++) {
      expect((await mailer.consumeIp('203.0.113.1', { chargeGlobal: true })).mailBlockedFor).toBe(
        0,
      );
      expect((await mailer.consumeIp('203.0.113.1', { chargeGlobal: true })).mailBlockedFor).toBe(
        0,
      );
      expect(capEvents()).toBe(round - 1);
      for (let i = 0; i < 3; i++) {
        expect(
          (await mailer.consumeIp('203.0.113.1', { chargeGlobal: true })).mailBlockedFor,
        ).toBeGreaterThan(0);
      }
      expect(capEvents()).toBe(round);
      now += 61_000;
    }
  });

  it('leaves the IP slot available when the global cap refuses', async () => {
    let now = 0;
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (async () => undefined) as unknown as typeof transport.sendMail;
    const mailer = createMailer(transport, 'fish@bas.lu', {
      store: memoryHitStore(() => now),
      log: () => undefined,
      limits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 2, windowMs: 3_600_000 },
        perIpRequests: { max: 100, windowMs: 3_600_000 },
        global: { max: 1, windowMs: 60_000 },
      },
    });
    await mailer.sendVerification('a@bas.lu', 'https://x.test/a');
    for (let i = 0; i < 5; i++) {
      expect((await mailer.consumeIp('203.0.113.9')).wait).toBe(0);
      await expect(mailer.sendVerification('b@bas.lu', 'https://x.test/b')).rejects.toThrow(
        MailThrottledError,
      );
    }
    now += 61_000;
    expect((await mailer.consumeIp('203.0.113.9')).wait).toBe(0);
    expect((await mailer.consumeIp('203.0.113.9')).wait).toBe(0);
    expect((await mailer.consumeIp('203.0.113.9')).wait).toBeGreaterThan(0);
  });

  it('still refuses an exhausted IP while the global cap is spent', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (async () => undefined) as unknown as typeof transport.sendMail;
    const mailer = createMailer(transport, 'fish@bas.lu', {
      store: memoryHitStore(() => 0),
      log: () => undefined,
      limits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 1, windowMs: 3_600_000 },
        global: { max: 1, windowMs: 60_000 },
      },
    });
    expect((await mailer.consumeIp('203.0.113.9')).wait).toBe(0);
    await mailer.sendVerification('a@bas.lu', 'https://x.test/a');
    expect((await mailer.consumeIp('203.0.113.9')).wait).toBeGreaterThan(0);
  });

  it('sends nothing for a request admitted without an IP charge, even if the cap frees meanwhile', async () => {
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
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 2, windowMs: 3_600_000 },
        global: { max: 1, windowMs: 60_000 },
      },
    });
    await mailer.sendVerification('a@bas.lu', 'https://x.test/a');
    const admission = await mailer.consumeIp('203.0.113.9');
    expect(admission.wait).toBe(0);
    expect(admission.mailBlockedFor).toBeGreaterThan(0);
    now += 61_000;
    await expect(
      mailer.runAdmitted(admission, () => mailer.sendVerification('b@bas.lu', 'https://x.test/b')),
    ).rejects.toThrow(MailThrottledError);
    expect(sent).toEqual(['a@bas.lu']);
    await mailer.sendVerification('b@bas.lu', 'https://x.test/b');
    expect(sent).toEqual(['a@bas.lu', 'b@bas.lu']);
  });

  it('refuses mail without logging the cap event when the store throws', async () => {
    const logs: string[] = [];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    let sent = 0;
    transport.sendMail = (async () => {
      sent++;
    }) as unknown as typeof transport.sendMail;
    const broken = {
      consume: () => Promise.reject(new Error('db down')),
      remaining: () => Promise.reject(new Error('db down')),
    };
    const mailer = createMailer(transport, 'fish@bas.lu', {
      store: broken,
      log: (m) => logs.push(m),
    });
    await expect(mailer.sendVerification('a@bas.lu', 'https://x.test/a')).rejects.toThrow(
      MailThrottledError,
    );
    expect(sent).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('mail limiter unavailable');
    expect(logs.some((m) => m.includes('mail_global_cap_reached'))).toBe(false);
  });
});

describe('ipBucket', () => {
  it('leaves IPv4 untouched', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
  });

  it('treats an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('::ffff:cb00:7109')).toBe('203.0.113.9');
  });

  it('puts compressed and expanded forms of one /64 in the same bucket', () => {
    const a = ipBucket('2001:db8:0:1::5');
    expect(ipBucket('2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd')).toBe(a);
    expect(ipBucket('2001:DB8:0:1:0:0:0:1')).toBe(a);
  });

  it('keeps different /64s apart', () => {
    expect(ipBucket('2001:db8:0:1::5')).not.toBe(ipBucket('2001:db8:0:2::5'));
    expect(ipBucket('2001:db8:0:1::5')).not.toBe(ipBucket('2001:db9:0:1::5'));
  });

  it('handles :: inside the prefix and an embedded IPv4 tail', () => {
    expect(ipBucket('2001:db8::1')).toBe(ipBucket('2001:db8:0:0:9::1'));
    expect(ipBucket('2001:db8:0:1::1.2.3.4')).toBe(ipBucket('2001:db8:0:1::7'));
  });

  it('drops a zone id', () => {
    expect(ipBucket('fe80::1%eth0')).toBe(ipBucket('fe80::2'));
    expect(ipBucket('203.0.113.9%eth0')).toBe('203.0.113.9');
  });

  it('keys malformed input on the raw string without throwing', () => {
    for (const garbage of ['', 'not-an-ip', '2001:db8::1::2', '1.2.3', '12345::1', 'g::1']) {
      expect(ipBucket(garbage)).toBe(garbage);
    }
  });
});
