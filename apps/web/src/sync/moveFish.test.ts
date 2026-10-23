import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../ui/api';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from './fixtures';
import { adultLengthRefusal } from './fishFit';
import { movableFish, moveRefusalText, moveTargets } from './moveFish';

const display = tankFixture();
const other = tankFixture({ id: '00000000-0000-4000-8000-0000000000c1', name: 'Second' });
const quarantine = tankFixture({
  id: '00000000-0000-4000-8000-0000000000c2',
  name: 'Quarantine',
  quarantine: true,
});

describe('moveTargets', () => {
  it('sends a display tank fish to the quarantine tank only', () => {
    expect(
      moveTargets(display, [display, other, quarantine], 'neon-tetra', speciesFixture()),
    ).toEqual([quarantine]);
  });

  it('sends a quarantine fish back to the display tanks', () => {
    expect(
      moveTargets(quarantine, [display, other, quarantine], 'neon-tetra', speciesFixture()),
    ).toEqual([display, other]);
  });

  it('skips tanks of the other kind of water', () => {
    const reef = tankFixture({
      id: '00000000-0000-4000-8000-0000000000c3',
      name: 'Reef quarantine',
      biome: 'reef',
      quarantine: true,
    });
    expect(
      moveTargets(display, [display, reef, quarantine], 'neon-tetra', speciesFixture()),
    ).toEqual([quarantine]);
  });

  describe('adult length gate', () => {
    const tang = speciesFixture({
      id: 'blue-tang',
      commonName: 'Blue tang',
      lifecycle: { ...speciesFixture().lifecycle, maxSizeM: 0.267 },
    });

    it('never offers quarantine to a species that outgrows a nano tank', () => {
      const nanoQuarantine = tankFixture({
        id: '00000000-0000-4000-8000-0000000000ca',
        quarantine: true,
        size: 'nano30',
      });
      expect(moveTargets(display, [display, nanoQuarantine], 'blue-tang', tang)).toEqual([]);
    });

    it('says why quarantine is out of reach', () => {
      expect(adultLengthRefusal(tang, 'nano30', true)).toContain('quarantine');
      expect(adultLengthRefusal(tang, 'nano30', false)).toContain('Choose a bigger tank');
    });

    it('still offers a tank it fits', () => {
      const standard = tankFixture({
        id: '00000000-0000-4000-8000-0000000000c9',
        quarantine: true,
        size: 'standard',
      });
      expect(moveTargets(display, [display, standard], 'blue-tang', tang)).toEqual([standard]);
    });
  });

  describe('tank length gate', () => {
    const home = tankFixture({ id: '00000000-0000-4000-8000-0000000000c8', quarantine: true });
    const standard = tankFixture({ id: '00000000-0000-4000-8000-0000000000c4', size: 'standard' });
    const long = tankFixture({ id: '00000000-0000-4000-8000-0000000000c5', size: 'long300' });

    it('drops tanks shorter than the species minimum', () => {
      expect(moveTargets(home, [home, standard, long], 'silver-mono', speciesFixture())).toEqual([
        long,
      ]);
    });

    it('keeps a tank exactly at the minimum length', () => {
      expect(moveTargets(home, [home, long], 'silver-mono', speciesFixture())).toEqual([long]);
    });

    it('does not gate species without a minimum', () => {
      expect(moveTargets(home, [home, standard], 'neon-tetra', speciesFixture())).toEqual([
        standard,
      ]);
    });

    it('lets a gated fish into a short quarantine tank', () => {
      const longHome = tankFixture({ id: '00000000-0000-4000-8000-0000000000c7', size: 'long300' });
      const shortQuarantine = tankFixture({
        id: '00000000-0000-4000-8000-0000000000c6',
        size: 'nano30',
        quarantine: true,
      });
      expect(
        moveTargets(longHome, [longHome, shortQuarantine], 'silver-mono', speciesFixture()),
      ).toEqual([shortQuarantine]);
    });
  });

  it('has no target without a quarantine tank', () => {
    expect(moveTargets(display, [display, other], 'neon-tetra', speciesFixture())).toEqual([]);
  });
});

describe('movableFish', () => {
  it('skips the dead', () => {
    const tank = tankFixture({
      fish: [
        fishFixture(FISH_1),
        fishFixture(FISH_2, { status: 'dead', diedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    });
    expect(movableFish(tank).map((f) => f.id)).toEqual([FISH_1]);
  });
});

describe('moveRefusalText', () => {
  const conflict = (reason: ConstructorParameters<typeof ApiRequestError>[5]) =>
    new ApiRequestError(409, 'conflict', 'server words', {}, null, reason);

  it('words each 409 reason for the player', () => {
    expect(moveRefusalText(conflict('fish_dead'), 'Pip', 'Q')).toContain('Pip has died');
    expect(moveRefusalText(conflict('wrong_biome'), 'Pip', 'Q')).toContain(
      'different kind of water',
    );
    expect(moveRefusalText(conflict('tank_full'), 'Pip', 'Q')).toContain('Q has no room for Pip');
    expect(moveRefusalText(conflict('key_reused'), 'Pip', 'Q')).toContain('Press the button again');
  });

  it('keeps the server text for a 409 it has no wording for', () => {
    expect(moveRefusalText(conflict(null), 'Pip', 'Q')).toBe('server words');
  });

  it('words a 429 with and without a wait', () => {
    const limited = (retry: number | null) =>
      new ApiRequestError(429, 'rate_limited', 'x', {}, retry);
    expect(moveRefusalText(limited(30), 'Pip', 'Q')).toContain('30 seconds');
    expect(moveRefusalText(limited(null), 'Pip', 'Q')).toContain('Wait a moment');
  });

  it('returns null for anything else', () => {
    expect(moveRefusalText(new ApiRequestError(0, 'network', 'offline'), 'Pip', 'Q')).toBeNull();
    expect(moveRefusalText(new Error('boom'), 'Pip', 'Q')).toBeNull();
  });
});
