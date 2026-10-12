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
});
