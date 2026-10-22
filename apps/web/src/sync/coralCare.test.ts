import type { Coral, Equipment } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../ui/api';
import { BUNDLED_CORALS } from './bundledCorals';
import {
  bleachLevel,
  describeBleach,
  fragChoices,
  fragRefusalText,
  fragWhy,
  lampWarning,
  reefIsBleaching,
  sameCorals,
} from './coralCare';

const coral = (over: Partial<Coral> = {}): Coral => ({
  key: 's1',
  assetId: 'acropora-cytherea',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1.6,
  minSize: 0.4,
  maxSize: 2,
  fragMinSize: 1.5,
  bleach: 0,
  ...over,
});

const light = (tier: number, intensity: number): Equipment['light'] => ({
  tier,
  intensity,
  onHour: 8,
  offHour: 20,
});

describe('fragging eligibility', () => {
  it('enables a grown, healthy colony', () => {
    expect(fragWhy(coral(), 0.3)).toBeNull();
  });

  it('enables a colony exactly at its frag size and bleach limit', () => {
    expect(fragWhy(coral({ size: 1.5, bleach: 0.3 }), 0.3)).toBeNull();
  });

  it('disables a colony below fragMinSize and says how much it needs', () => {
    expect(fragWhy(coral({ size: 1.49 }), 0.3)).toMatch(/Not grown enough.*149%.*150%/);
  });

  it('disables a colony bleached beyond the limit', () => {
    expect(fragWhy(coral({ bleach: 0.31 }), 0.3)).toMatch(/Too bleached/);
  });

  it('puts the bleaching first when a colony is both small and bleached', () => {
    expect(fragWhy(coral({ size: 1, bleach: 0.9 }), 0.3)).toMatch(/Too bleached/);
  });

  it('lists layout corals before fragments and numbers repeats', () => {
    const choices = fragChoices([
      coral({ key: 's1.1', parentKey: 's1', position: [0, 0], size: 0.3 }),
      coral({ key: 's1' }),
      coral({ key: 's2', assetId: 'brain-coral', size: 1 }),
      coral({ key: 's3' }),
    ]);
    expect(choices.map((c) => c.label)).toEqual([
      'acropora cytherea 1',
      'brain coral',
      'acropora cytherea 2',
      'acropora cytherea fragment',
    ]);
    expect(choices.map((c) => c.enabled)).toEqual([true, false, true, false]);
  });

  it('is empty for no coral state', () => {
    expect(fragChoices(undefined)).toEqual([]);
    expect(fragChoices([])).toEqual([]);
  });

  it('matches the limit the server reads from content', () => {
    expect(BUNDLED_CORALS.params.fragMaxBleach).toBe(0.3);
  });
});

describe('bleach wording', () => {
  it('names the level and the percentage', () => {
    expect(bleachLevel(0)).toBe('healthy');
    expect(bleachLevel(0.2)).toBe('pale');
    expect(bleachLevel(0.5)).toBe('bleaching');
    expect(bleachLevel(0.95)).toBe('bleached');
    expect(describeBleach(0.5)).toBe('bleaching, 50% bleached');
  });

  it('says a reef is bleaching only past the fragging limit', () => {
    expect(reefIsBleaching([coral({ bleach: 0.3 })])).toBe(false);
    expect(reefIsBleaching([coral({ bleach: 0.31 })])).toBe(true);
    expect(reefIsBleaching(undefined)).toBe(false);
  });
});

describe('lamp warning', () => {
  const acropora = BUNDLED_CORALS.corals.find((s) => s.id === 'acropora-cytherea');
  if (!acropora) throw new Error('acropora-cytherea missing from content/corals.json');

  it('is quiet while the lamp is within what the coral takes', () => {
    expect(lampWarning([coral()], light(1, acropora.lightMax), BUNDLED_CORALS)).toBeNull();
  });

  it('names the coral once tier times intensity passes its limit', () => {
    const warning = lampWarning([coral()], light(2, acropora.lightMax), BUNDLED_CORALS);
    expect(warning).toMatch(/too bright for the acropora cytherea/);
  });

  it('names each species once', () => {
    const warning = lampWarning(
      [coral(), coral({ key: 's2' }), coral({ key: 's3', assetId: 'brain-coral' })],
      light(3, 1),
      BUNDLED_CORALS,
    );
    expect(warning?.match(/acropora cytherea/g)).toHaveLength(1);
  });

  it('is quiet with no corals or an unknown asset', () => {
    expect(lampWarning([], light(3, 1), BUNDLED_CORALS)).toBeNull();
    expect(lampWarning(undefined, light(3, 1), BUNDLED_CORALS)).toBeNull();
    expect(lampWarning([coral({ assetId: 'mystery' })], light(3, 1), BUNDLED_CORALS)).toBeNull();
  });
});

describe('sameCorals', () => {
  it('compares by value', () => {
    expect(sameCorals([coral()], [coral()])).toBe(true);
    expect(sameCorals([coral()], [coral({ size: 1.7 })])).toBe(false);
    expect(sameCorals([coral()], [coral({ bleach: 0.1 })])).toBe(false);
    expect(sameCorals([coral()], [])).toBe(false);
    expect(sameCorals(undefined, undefined)).toBe(true);
    expect(sameCorals(undefined, [])).toBe(false);
  });

  it('sees a fragment move', () => {
    const a = coral({ key: 's1.1', parentKey: 's1', position: [0.1, 0.2] });
    const b = coral({ key: 's1.1', parentKey: 's1', position: [0.1, 0.3] });
    expect(sameCorals([a], [b])).toBe(false);
  });
});

describe('fragRefusalText', () => {
  const refused = (status: number, reason: ApiRequestError['reason']) =>
    new ApiRequestError(status, 'conflict', 'server words', {}, null, reason);

  it('explains no room on the substrate', () => {
    expect(fragRefusalText(refused(409, 'coral_no_room'), 'brain coral')).toMatch(
      /no room on the substrate near the brain coral/,
    );
  });

  it('falls back to the server words for a reason it has no text for', () => {
    expect(fragRefusalText(refused(409, 'tank_full'), 'brain coral')).toBe('server words');
  });

  it('leaves other failures to the caller', () => {
    expect(fragRefusalText(new Error('boom'), 'brain coral')).toBeNull();
    expect(fragRefusalText(refused(500, null), 'brain coral')).toBeNull();
  });
});
