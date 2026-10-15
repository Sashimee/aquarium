import { legacyTintSeed } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { item } from './fixtures';
import { layoutKey } from './key';

describe('layoutKey', () => {
  it('treats a missing seed as the one the server assigns', () => {
    const bare = item('boulder-01', 0.1, 0.2);
    const stamped = { ...bare, tintSeed: legacyTintSeed(bare) };
    expect(layoutKey([stamped])).toBe(layoutKey([bare]));
  });

  it('tells apart two layouts that differ only in the seed', () => {
    const bare = item('boulder-01', 0.1, 0.2);
    expect(layoutKey([{ ...bare, tintSeed: legacyTintSeed(bare) + 1 }])).not.toBe(
      layoutKey([bare]),
    );
  });
});
