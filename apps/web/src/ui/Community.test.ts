import type { CommunityQuota } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { portionChoices } from './Community';

const quota = (remaining: number): CommunityQuota => ({
  limit: 2,
  used: 2 - remaining,
  remaining,
  windowMs: 86_400_000,
  resetsAt: null,
});

describe('portionChoices', () => {
  it('offers only amounts the player and the tank can still take', () => {
    expect(portionChoices(quota(2), 3).map((c) => c.portion)).toEqual([0.1, 0.25, 0.5, 1]);
    expect(portionChoices(quota(0.3), 3).map((c) => c.portion)).toEqual([0.1, 0.25]);
    expect(portionChoices(quota(2), 0.5).map((c) => c.portion)).toEqual([0.1, 0.25, 0.5]);
  });

  it('offers nothing without an allowance or when the tank is full', () => {
    expect(portionChoices(null, 3)).toEqual([]);
    expect(portionChoices(quota(2), 0)).toEqual([]);
    expect(portionChoices(quota(0.05), 3)).toEqual([]);
  });
});
