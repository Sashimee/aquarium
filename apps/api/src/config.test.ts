import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  BETTER_AUTH_SECRET: 'a'.repeat(40),
  APP_URL: 'https://fish.bas.lu',
};

describe('loadConfig', () => {
  it('applies mail defaults and parses the minimal environment', () => {
    const c = loadConfig(valid);
    expect(c.mailFrom).toBe('fish@bas.lu');
    expect(c.smtp).toEqual({ host: 'mailrelay', port: 587 });
    expect(c.indexable).toBe(false);
  });

  it('enables test hooks only when NODE_ENV is exactly test', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'test' }).testHooks).toBe(true);
    for (const NODE_ENV of ['production', 'development', 'Test', undefined]) {
      expect(loadConfig({ ...valid, ...(NODE_ENV ? { NODE_ENV } : {}) }).testHooks).toBe(false);
    }
  });

  it('only treats SITE_INDEXABLE=true as indexable', () => {
    expect(loadConfig({ ...valid, SITE_INDEXABLE: 'true' }).indexable).toBe(true);
    expect(loadConfig({ ...valid, SITE_INDEXABLE: 'TRUE' }).indexable).toBe(false);
    expect(loadConfig({ ...valid, SITE_INDEXABLE: '1' }).indexable).toBe(false);
  });

  it('refuses a MAIL_FROM outside bas.lu', () => {
    expect(() => loadConfig({ ...valid, MAIL_FROM: 'fish@example.com' })).toThrow(/bas\.lu/);
    expect(() => loadConfig({ ...valid, MAIL_FROM: 'fish@evilbas.lu' })).toThrow(/bas\.lu/);
  });

  it('reports every missing or weak variable without echoing values', () => {
    const attempt = () => loadConfig({ BETTER_AUTH_SECRET: 'short+secret/value=' });
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/APP_URL/);
    expect(attempt).toThrow(/BETTER_AUTH_SECRET/);
    expect(attempt).not.toThrow(/short\+secret/);
  });

  it('requires https in production', () => {
    expect(() =>
      loadConfig({ ...valid, APP_URL: 'http://fish.bas.lu', NODE_ENV: 'production' }),
    ).toThrow(/https/);
    expect(loadConfig({ ...valid, APP_URL: 'http://localhost:3000' }).appUrl.port).toBe('3000');
  });

  describe('Stripe keys', () => {
    const secret = `sk_test_${'a'.repeat(24)}`;
    const webhook = `whsec_${'b'.repeat(24)}`;

    it('leaves payments off when neither key is set', () => {
      expect(loadConfig(valid).stripe).toBeNull();
      expect(
        loadConfig({ ...valid, STRIPE_SECRET_KEY: ' ', STRIPE_WEBHOOK_SECRET: '' }).stripe,
      ).toBeNull();
    });

    it('turns payments on when both are set', () => {
      const c = loadConfig({ ...valid, STRIPE_SECRET_KEY: secret, STRIPE_WEBHOOK_SECRET: webhook });
      expect(c.stripe).toEqual({ secretKey: secret, webhookSecret: webhook });
    });

    it('refuses exactly one of the two, without echoing either', () => {
      for (const only of [{ STRIPE_SECRET_KEY: secret }, { STRIPE_WEBHOOK_SECRET: webhook }]) {
        const attempt = () => loadConfig({ ...valid, ...only });
        expect(attempt).toThrow(/together or not at all/);
        expect(attempt).not.toThrow(/aaaaaaaa|bbbbbbbb/);
      }
    });

    it('refuses a live key unless PAYMENTS_LIVE=1, naming the variable and not the key', () => {
      const live = `sk_live_${'c'.repeat(24)}`;
      for (const flag of [undefined, '', '0', 'true']) {
        const attempt = () =>
          loadConfig({
            ...valid,
            STRIPE_SECRET_KEY: live,
            STRIPE_WEBHOOK_SECRET: webhook,
            ...(flag === undefined ? {} : { PAYMENTS_LIVE: flag }),
          });
        expect(attempt).toThrow(/PAYMENTS_LIVE=1/);
        expect(attempt).not.toThrow(/cccccccc/);
      }
      const c = loadConfig({
        ...valid,
        STRIPE_SECRET_KEY: live,
        STRIPE_WEBHOOK_SECRET: webhook,
        PAYMENTS_LIVE: '1',
      });
      expect(c.stripe?.secretKey).toBe(live);
    });

    it('still takes a restricted live key only with the opt-in', () => {
      const restricted = `rk_live_${'d'.repeat(24)}`;
      expect(() =>
        loadConfig({ ...valid, STRIPE_SECRET_KEY: restricted, STRIPE_WEBHOOK_SECRET: webhook }),
      ).toThrow(/PAYMENTS_LIVE/);
    });

    it('refuses values that are not Stripe keys', () => {
      expect(() =>
        loadConfig({ ...valid, STRIPE_SECRET_KEY: 'pk_test_abc', STRIPE_WEBHOOK_SECRET: webhook }),
      ).toThrow(/STRIPE_SECRET_KEY/);
      expect(() =>
        loadConfig({ ...valid, STRIPE_SECRET_KEY: secret, STRIPE_WEBHOOK_SECRET: 'abc' }),
      ).toThrow(/STRIPE_WEBHOOK_SECRET/);
    });
  });
});
