import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../ui/api';
import { FISH_1, FISH_2, fishFixture, tankFixture } from './fixtures';
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
    expect(moveTargets(display, [display, other, quarantine])).toEqual([quarantine]);
  });

  it('sends a quarantine fish back to the display tanks', () => {
    expect(moveTargets(quarantine, [display, other, quarantine])).toEqual([display, other]);
  });

  it('skips tanks of the other kind of water', () => {
    const reef = tankFixture({
      id: '00000000-0000-4000-8000-0000000000c3',
      name: 'Reef quarantine',
      biome: 'reef',
      quarantine: true,
    });
    expect(moveTargets(display, [display, reef, quarantine])).toEqual([quarantine]);
  });

  it('has no target without a quarantine tank', () => {
    expect(moveTargets(display, [display, other])).toEqual([]);
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
