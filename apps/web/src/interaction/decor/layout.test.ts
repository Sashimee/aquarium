import { decorPositionLimits } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { item } from './fixtures';
import { sanitizeLayout } from './layout';
import { VACATION_FEEDER_ASSET_ID } from './spec';

describe('sanitizeLayout', () => {
  it('drops pieces from the other biome and counts them', () => {
    const layout = [
      item('boulder-01', 0, 0),
      item('reef-arch', 0.2, 0),
      item('brain-coral', -0.2, 0),
    ];
    const fresh = sanitizeLayout(layout, 'freshwater');
    expect(fresh.layout.map((i) => i.assetId)).toEqual(['boulder-01']);
    expect(fresh.dropped).toBe(2);
    const reef = sanitizeLayout(
      [item('driftwood-branch', 0, 0), item('reef-arch', 0.2, 0)],
      'reef',
    );
    expect(reef.layout.map((i) => i.assetId)).toEqual(['reef-arch']);
    expect(reef.dropped).toBe(1);
  });

  it('keeps only the first vacation feeder', () => {
    const layout = [
      item(VACATION_FEEDER_ASSET_ID, 0.1, 0),
      item(VACATION_FEEDER_ASSET_ID, -0.1, 0),
    ];
    const out = sanitizeLayout(layout, 'freshwater');
    expect(out.layout).toEqual([layout[0]]);
    expect(out.dropped).toBe(1);
  });

  it('pulls out-of-bounds pieces inside without dropping them', () => {
    const limits = decorPositionLimits();
    const out = sanitizeLayout([item('boulder-01', 5, -5, {}, 9)], 'reef');
    expect(out.dropped).toBe(0);
    expect(out.layout[0]?.position).toEqual([limits.x, limits.yMax, -limits.z]);
  });

  it('leaves a clean layout untouched', () => {
    const layout = [item('boulder-01', 0, 0), item(VACATION_FEEDER_ASSET_ID, 0.3, 0.1)];
    expect(sanitizeLayout(layout, 'reef')).toEqual({ layout, dropped: 0 });
  });
});
