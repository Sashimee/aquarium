import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { behaviourSchema, speciesSchema, traitSchema } from './species.js';

const dir = join(import.meta.dirname, '../../../content/species');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const contentSchema = speciesSchema.partial({ render: true });

describe('content/species', () => {
  it('has species files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes the shared schema', (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(contentSchema.safeParse(raw).error).toBeUndefined();
  });
});

describe('behaviour traits', () => {
  const base = JSON.parse(readFileSync(join(dir, 'neon-tetra.json'), 'utf8')) as {
    behaviour: Record<string, unknown>;
  };

  it('rejects a mistyped trait', () => {
    const r = behaviourSchema.safeParse({ ...base.behaviour, traits: ['rock-grazr'] });
    expect(r.success).toBe(false);
  });

  it('accepts every known trait', () => {
    for (const t of traitSchema.options) {
      expect(behaviourSchema.safeParse({ ...base.behaviour, traits: [t] }).success).toBe(true);
    }
  });

  it('accepts per-trait parameters and keeps them optional', () => {
    const r = behaviourSchema.safeParse({
      ...base.behaviour,
      traits: ['air-gulp', 'rock-grazer'],
      airGulp: { perHour: 4 },
      grazing: { meanIntervalS: 30, minS: 1, maxS: 3 },
      flare: { minS: 2, maxS: 5 },
      station: { radiusBodyLengths: 2 },
      refuge: { afterStartleS: 30 },
      excursion: { meanIntervalS: 20 },
    });
    expect(r.error).toBeUndefined();
  });

  it('rejects out-of-range parameters and unknown keys', () => {
    const bad = [
      { airGulp: { perHour: 0 } },
      { grazing: { meanIntervalS: 10, minS: 5, maxS: 2 } },
      { flare: { minS: 6, maxS: 2 } },
      { station: { radiusBodyLengths: 1, restationMinS: 90, restationMaxS: 30 } },
      { airGulp: { perHour: 3, extra: 1 } },
    ];
    for (const extra of bad) {
      expect(behaviourSchema.safeParse({ ...base.behaviour, ...extra }).success).toBe(false);
    }
  });
});
