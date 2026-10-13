import { Euler, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import catalog from '../../public/assets/index.json';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { sampleCurrent, wrapPeriodS } from './current';
import { scatterPatch, type PlantInstance } from './placement';
import { SURFACE_MARGIN, leanSeconds, surfaceScaleCeiling } from './plants';
import { loadPreset } from './preset';
import { DEFAULT_CURRENT, glassExtent } from './TankScene';

const heights = new Map(
  catalog.assets.map((a) => [a.id, (a as { bounds?: { max: number[] } }).bounds?.max[1] ?? 0]),
);
const waterTop = DEFAULT_TANK.height - DEFAULT_TANK.freeboard;
const ground = (x: number, z: number) => substrateHeight(DEFAULT_TANK, x, z);
const flow = new Float64Array(3);

function tipHeight(
  assetId: string,
  plant: PlantInstance,
  current: typeof DEFAULT_CURRENT,
  timeS: number,
): number {
  const height = heights.get(assetId) ?? 0;
  const rooted = new Vector3(0, height * plant.scale, 0).applyEuler(
    new Euler(plant.tiltX, plant.yaw, plant.tiltZ, 'YXZ'),
  );
  sampleCurrent(current, plant.x, plant.y + rooted.y, plant.z, timeS, flow);
  const lean = new Vector3(flow[0] ?? 0, 0, flow[2] ?? 0).multiplyScalar(
    leanSeconds(assetId, height),
  );
  return plant.y + rooted.y + lean.y;
}

describe('freshwater plants against the water surface', () => {
  const preset = loadPreset('freshwater');
  const current = preset.current ?? DEFAULT_CURRENT;
  const limit = waterTop - SURFACE_MARGIN;

  it('keeps every patch plant under the surface at every point of the gust cycle', () => {
    let tallest = 0;
    for (const patch of preset.plantPatches) {
      const height = heights.get(patch.assetId) ?? 0;
      const plants = scatterPatch(
        patch,
        ground,
        () => false,
        glassExtent(DEFAULT_TANK),
        () => 0,
        surfaceScaleCeiling(waterTop, height),
      );
      expect(plants.length).toBe(patch.count);
      for (const plant of plants) {
        for (let t = 0; t < wrapPeriodS(current); t += 0.1) {
          const top = tipHeight(patch.assetId, plant, current, t);
          tallest = Math.max(tallest, top);
          expect(top, `${patch.id} at t=${t.toFixed(1)}s`).toBeLessThanOrEqual(limit);
        }
      }
    }
    expect(tallest).toBeGreaterThan(limit - 0.06);
  });

  it('keeps the preset scales under the ceiling so the clamp is only a guard', () => {
    const backRootY = ground(0, -(DEFAULT_TANK.depth / 2 - DEFAULT_TANK.glass)) - 0.004;
    for (const patch of preset.plantPatches) {
      const ceiling = surfaceScaleCeiling(waterTop, heights.get(patch.assetId) ?? 0);
      expect(patch.scale[1], patch.id).toBeLessThanOrEqual(ceiling(backRootY) + 1e-9);
    }
  });

  it('clamps an oversized patch below the surface', () => {
    const stems = preset.plantPatches.find((p) => p.id === 'stems-back');
    if (!stems) throw new Error('freshwater preset lost its stems-back patch');
    const patch = { ...stems, scale: [1.2, 1.6] as [number, number] };
    const plants = scatterPatch(
      patch,
      ground,
      () => false,
      glassExtent(DEFAULT_TANK),
      () => 0,
      surfaceScaleCeiling(waterTop, heights.get(patch.assetId) ?? 0),
    );
    for (const plant of plants) {
      expect(tipHeight(patch.assetId, plant, current, 0)).toBeLessThanOrEqual(limit);
    }
  });

  it('caps scale by root height and never goes negative', () => {
    const ceiling = surfaceScaleCeiling(0.47, 0.35);
    expect(ceiling(0.11)).toBeCloseTo(0.33 / 0.35, 6);
    expect(ceiling(0.9)).toBe(0);
  });
});
