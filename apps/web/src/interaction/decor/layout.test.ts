import { decorPositionLimits } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { item, spec } from './fixtures';
import { sanitizeLayout } from './layout';
import { SURFACE_MARGIN } from '../../scene/plants';
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
    expect(sanitizeLayout(layout, 'reef')).toEqual({ layout, dropped: 0, shrunk: 0 });
  });

  describe('plants taller than the water', () => {
    const fern = spec('java-fern');
    const fit = { specs: new Map([[fern.assetId, fern]]), waterTop: 0.3 };
    const tall = (y: number, scale: number) => item('java-fern', 0, 0, { scale }, y);

    it('shrinks a plant that would poke through the surface', () => {
      const out = sanitizeLayout([tall(0.1, 1)], 'freshwater', fit);
      expect(out.dropped).toBe(0);
      expect(out.shrunk).toBe(1);
      const shrunk = out.layout[0];
      expect(shrunk?.scale).toBeLessThan(1);
      expect(
        (shrunk?.position[1] ?? 0) + fern.box.max[1] * (shrunk?.scale ?? 0),
      ).toBeLessThanOrEqual(0.3 - SURFACE_MARGIN);
    });

    it('drops a plant that would have to shrink too far', () => {
      const out = sanitizeLayout([tall(0.285, 1)], 'freshwater', fit);
      expect(out.layout).toEqual([]);
      expect(out.dropped).toBe(1);
      expect(out.shrunk).toBe(0);
    });

    it('leaves a plant that fits, and every plant when the water level is unknown', () => {
      const fine = tall(0.06, 0.5);
      expect(sanitizeLayout([fine], 'freshwater', fit)).toEqual({
        layout: [fine],
        dropped: 0,
        shrunk: 0,
      });
      const poking = tall(0.2, 3);
      expect(sanitizeLayout([poking], 'freshwater').layout).toEqual([poking]);
    });
  });
});
