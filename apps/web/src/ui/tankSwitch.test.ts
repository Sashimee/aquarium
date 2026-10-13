import { describe, expect, it } from 'vitest';
import { TANK_A, TANK_B, tankFixture } from '../sync/fixtures';
import { canSwitch, planSwitch, shownBiome } from './tankSwitch';

const fresh = tankFixture({ id: TANK_A, biome: 'freshwater' });
const reef = tankFixture({ id: TANK_B, biome: 'reef' });

describe('planSwitch', () => {
  it('retargets the demo tank for anonymous, unverified and offline players', () => {
    for (const phase of ['anonymous', 'unverified', 'offline'] as const) {
      const state = { phase, tanks: [], activeId: null };
      expect(planSwitch(state, 'freshwater', 'reef')).toEqual({ kind: 'demo', biome: 'reef' });
      expect(planSwitch(state, 'reef', 'reef')).toEqual({ kind: 'none' });
    }
  });

  it('does nothing when the active tank already has that biome', () => {
    const state = { phase: 'ready', tanks: [fresh, reef], activeId: TANK_A } as const;
    expect(planSwitch(state, 'reef', 'freshwater')).toEqual({ kind: 'none' });
  });

  it('selects an existing tank of the other biome', () => {
    const state = { phase: 'ready', tanks: [fresh, reef], activeId: TANK_A } as const;
    expect(planSwitch(state, 'freshwater', 'reef')).toEqual({ kind: 'select', tankId: TANK_B });
  });

  it('leads to creating a tank when the player has none of that biome', () => {
    const state = { phase: 'ready', tanks: [fresh], activeId: TANK_A } as const;
    expect(planSwitch(state, 'freshwater', 'reef')).toEqual({ kind: 'create', biome: 'reef' });
  });

  it('leads a signed-in player with no tank at all to create one', () => {
    const state = { phase: 'ready', tanks: [], activeId: null } as const;
    expect(planSwitch(state, 'freshwater', 'freshwater')).toEqual({
      kind: 'create',
      biome: 'freshwater',
    });
  });
});

describe('shownBiome', () => {
  it('is the demo biome without a saved tank', () => {
    expect(shownBiome({ phase: 'anonymous', tanks: [], activeId: null }, 'reef')).toBe('reef');
    expect(shownBiome({ phase: 'ready', tanks: [], activeId: null }, 'reef')).toBe('reef');
  });

  it('is the active saved tank biome, whatever the demo says', () => {
    const state = { phase: 'ready', tanks: [fresh, reef], activeId: TANK_B } as const;
    expect(shownBiome(state, 'freshwater')).toBe('reef');
  });
});

describe('canSwitch', () => {
  it('is off while tanks load or a request is in flight', () => {
    expect(canSwitch({ phase: 'loading', busy: false })).toBe(false);
    expect(canSwitch({ phase: 'ready', busy: true })).toBe(false);
    expect(canSwitch({ phase: 'ready', busy: false })).toBe(true);
    expect(canSwitch({ phase: 'anonymous', busy: false })).toBe(true);
  });
});
