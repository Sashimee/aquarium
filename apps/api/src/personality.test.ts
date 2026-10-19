import { randomUUID } from 'node:crypto';
import { personalitySchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { personalityFromFishId } from './personality.ts';

describe('personalityFromFishId', () => {
  it('is deterministic for a given fish id', () => {
    const id = randomUUID();
    expect(personalityFromFishId(id)).toEqual(personalityFromFishId(id));
  });

  it('stays within 0..1 and passes the shared schema', () => {
    for (let i = 0; i < 500; i++) {
      expect(() => personalitySchema.parse(personalityFromFishId(randomUUID()))).not.toThrow();
    }
  });

  it('spreads across the range and differs between fish and between traits', () => {
    const rolls = Array.from({ length: 300 }, () => personalityFromFishId(randomUUID()));
    const boldness = rolls.map((r) => r.boldness);
    expect(Math.min(...boldness)).toBeLessThan(0.15);
    expect(Math.max(...boldness)).toBeGreaterThan(0.85);
    expect(new Set(boldness).size).toBeGreaterThan(200);
    const [first] = rolls;
    expect(new Set([first?.boldness, first?.greed, first?.sociability]).size).toBeGreaterThan(1);
  });

  it('matches known vectors so a hash change cannot silently reroll every fish', () => {
    expect(personalityFromFishId('00000000-0000-4000-8000-000000000000')).toEqual({
      boldness: 0.702,
      greed: 0.052,
      sociability: 0.53,
    });
  });
});
