import { describe, expect, it } from 'vitest';
import { fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import { dipStrip, rawValues } from '../sync/waterTest';
import { STALE_AFTER_MS, chipState } from './chemistryChip';
import { getDip, putDip, subscribeDips, type Dip } from './dipStore';

const NOW = 1_700_000_000_000;
const species = [speciesFixture()];

function dipFor(tank: ReturnType<typeof tankFixture>, over: Partial<Dip> = {}): Dip {
  return {
    at: NOW,
    strip: dipStrip(tank.biome, rawValues(tank)),
    temperatureC: tank.chemistry.temperatureC,
    guesses: {},
    revealed: true,
    ...over,
  };
}

function withAmmonia(ammonia: number) {
  const base = tankFixture();
  return tankFixture({ water: { ...base.water, ammonia }, fish: [fishFixture('fish-1')] });
}

describe('chipState', () => {
  it('says no test yet before any dip', () => {
    const s = chipState(tankFixture(), species, null, NOW);
    expect(s.status).toBe('none');
    expect(s.verdict).toBe('No test yet');
    expect(s.values).toEqual([]);
    expect(s.ariaLabel).toContain('no test yet');
  });

  it('is safe for clean water once the pads are read', () => {
    const tank = withAmmonia(0);
    const s = chipState(tank, species, dipFor(tank), NOW);
    expect(s.status).toBe('safe');
    expect(s.values.map((v) => v.key)).toEqual(['ph', 'ammonia', 'temperature']);
  });

  it('warns on moderate ammonia', () => {
    const tank = withAmmonia(0.15);
    expect(chipState(tank, species, dipFor(tank), NOW).status).toBe('warning');
  });

  it('is dangerous on high ammonia', () => {
    const tank = withAmmonia(8);
    const s = chipState(tank, species, dipFor(tank), NOW);
    expect(s.status).toBe('danger');
    expect(s.verdict).toBe('Dangerous');
  });

  it('does not leak unread pads before the player reads them', () => {
    const tank = withAmmonia(8);
    const s = chipState(tank, species, dipFor(tank, { revealed: false }), NOW);
    expect(s.status).toBe('unread');
    expect(s.values.find((v) => v.key === 'ammonia')?.text).toBe('?');
    expect(s.ariaLabel).toContain('Ammonia not read yet');

    const guessed = dipFor(tank, { revealed: false, guesses: { ammonia: 0 } });
    expect(chipState(tank, species, guessed, NOW).status).toBe('danger');
  });

  it('marks an old reading stale and keeps what it was', () => {
    const tank = withAmmonia(8);
    const s = chipState(tank, species, dipFor(tank, { at: NOW - STALE_AFTER_MS - 60_000 }), NOW);
    expect(s.status).toBe('stale');
    expect(s.verdict).toBe('Stale reading, was dangerous');
    expect(s.ageText).toBe('31 minutes ago');
  });

  it('treats a reading exactly at the limit as fresh', () => {
    const tank = withAmmonia(0);
    const dip = dipFor(tank, { at: NOW - STALE_AFTER_MS });
    expect(chipState(tank, species, dip, NOW).status).toBe('safe');
  });

  it('never says safe while a pad is unread, but still shows a read unsafe pad', () => {
    const tank = withAmmonia(8);
    const onlyPh = dipFor(tank, { revealed: false, guesses: { ph: 7 } });
    const s = chipState(tank, species, onlyPh, NOW);
    expect(s.status).toBe('partial');
    expect(s.verdict).not.toMatch(/safe/i);
    expect(s.ariaLabel).toContain('Ammonia not read yet');

    const clean = withAmmonia(0);
    const cleanPartial = dipFor(clean, { revealed: false, guesses: { ph: 7 } });
    expect(chipState(clean, species, cleanPartial, NOW).status).toBe('partial');

    const onlyAmmonia = dipFor(tank, { revealed: false, guesses: { ammonia: 0 } });
    expect(chipState(tank, species, onlyAmmonia, NOW).status).toBe('danger');
  });

  it('warns on a temperature outside what the fish like', () => {
    const tank = withAmmonia(0);
    expect(chipState(tank, species, dipFor(tank), NOW).status).toBe('safe');
    expect(chipState(tank, species, dipFor(tank, { temperatureC: 44 }), NOW).status).toBe(
      'warning',
    );
    expect(chipState(tank, species, dipFor(tank, { temperatureC: 4 }), NOW).status).toBe('warning');
  });

  it('flags a bad temperature even when no pad is read', () => {
    const tank = withAmmonia(0);
    const hot = dipFor(tank, { revealed: false, temperatureC: 44 });
    expect(chipState(tank, species, hot, NOW).status).toBe('warning');
    const fine = dipFor(tank, { revealed: false });
    expect(chipState(tank, species, fine, NOW).status).toBe('unread');
  });

  it('updates when a newer dip replaces the old one', () => {
    const bad = withAmmonia(8);
    const good = withAmmonia(0);
    putDip('replace-tank', dipFor(bad));
    const first = getDip('replace-tank');
    expect(first && chipState(bad, species, first, NOW).status).toBe('danger');
    putDip('replace-tank', dipFor(good));
    const second = getDip('replace-tank');
    expect(second && chipState(good, species, second, NOW).status).toBe('safe');
    expect(second).not.toBe(first);
  });

  it('gives a screen reader the verdict in words, not colour', () => {
    const tank = withAmmonia(0);
    const s = chipState(tank, species, dipFor(tank), NOW);
    expect(s.ariaLabel).toMatch(
      /^Water chemistry: Safe\. pH .+, Ammonia .+, Temp .+ °C\. Tested just now\./,
    );
  });
});

describe('dipStore', () => {
  it('notifies subscribers and returns the latest dip per tank', () => {
    const tank = tankFixture();
    let calls = 0;
    const off = subscribeDips(() => (calls += 1));
    const dip = dipFor(tank);
    putDip('chip-tank', dip);
    expect(getDip('chip-tank')).toBe(dip);
    expect(calls).toBe(1);
    off();
    putDip('chip-tank', dipFor(tank, { revealed: false }));
    expect(calls).toBe(1);
    expect(getDip('other-tank')).toBeNull();
  });
});
