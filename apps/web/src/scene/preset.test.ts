import { isDecorAssetForBiome } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import type { CatalogEntry } from './assets';
import { loadPreset, parsePreset } from './preset';
import catalog from '../../public/assets/index.json';
import { generateEuphyllia, parseEuphylliaId } from './euphyllia';
import {
  DEFAULT_CURRENT,
  checkClearOfGlass,
  checkEuphylliaClearOfGlass,
  glassExtent,
} from './TankScene';

const kinds = new Map(catalog.assets.map((a) => [a.id, a.kind]));

describe('freshwater preset', () => {
  const preset = loadPreset('freshwater');

  it('is the freshwater layout', () => {
    expect(preset.id).toBe('freshwater');
    expect(preset.biome).toBe('freshwater');
  });

  it('references only shipped assets of the right kind', () => {
    expect(kinds.get(preset.substrate?.assetId ?? '')).toBe('substrate');
    if (preset.substrate?.accentAssetId) {
      expect(kinds.get(preset.substrate.accentAssetId)).toBe('substrate');
    }
    for (const item of preset.decor) expect(kinds.has(item.assetId), item.assetId).toBe(true);
    for (const patch of preset.plantPatches) {
      expect(kinds.get(patch.assetId), patch.assetId).toBe('plant');
    }
  });

  it('seats rocks and wood on the substrate', () => {
    for (const item of preset.decor) {
      const kind = kinds.get(item.assetId);
      if (kind !== 'rock' && kind !== 'driftwood') continue;
      const ground = substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
      expect(Math.abs(item.position[1] - ground), item.assetId).toBeLessThan(0.03);
    }
  });

  it('keeps decor inside the tank footprint', () => {
    for (const item of preset.decor) {
      expect(Math.abs(item.position[0])).toBeLessThan(DEFAULT_TANK.length / 2);
      expect(Math.abs(item.position[2])).toBeLessThan(DEFAULT_TANK.depth / 2);
    }
  });
});

describe('parsePreset', () => {
  it('names the preset and the failing field on invalid data', () => {
    expect(() => parsePreset({ id: 'x' }, 'broken.json')).toThrow(/broken\.json.*invalid/);
  });
});

describe('reef preset', () => {
  const preset = loadPreset('reef');
  const entries = new Map(catalog.assets.map((a) => [a.id, a]));

  it('is the reef layout with live rock, corals and one host anemone', () => {
    expect(preset.biome).toBe('reef');
    const kindsUsed = preset.decor.map((d) => kinds.get(d.assetId));
    expect(kindsUsed.filter((k) => k === 'anemone')).toHaveLength(1);
    expect(kindsUsed.filter((k) => k === 'rock').length).toBeGreaterThanOrEqual(5);
    const corals = new Set(
      preset.decor.filter((d) => kinds.get(d.assetId) === 'coral').map((d) => d.assetId),
    );
    expect(corals).toContain('brain-coral');
    expect(corals).toContain('acropora-palmata');
    expect(corals).toContain('acropora-cytherea');
    expect(preset.substrate?.assetId).toBe('reef-sand');
    expect(preset.decor.filter((d) => d.assetId === 'reef-arch').length).toBeGreaterThanOrEqual(2);
    expect(kinds.get(preset.substrate?.assetId ?? '')).toBe('substrate');
  });

  it('references only shipped assets', () => {
    for (const item of preset.decor) {
      expect(kinds.has(item.assetId) || parseEuphylliaId(item.assetId), item.assetId).toBeTruthy();
    }
  });

  it('places a hammer and a torch Euphyllia colony', () => {
    const variants = preset.decor.map((d) => parseEuphylliaId(d.assetId)?.variant);
    expect(variants).toContain('hammer');
    expect(variants).toContain('torch');
  });

  it('keeps every footprint, with room for the anemone to sway, inside the glass', () => {
    const halfL = DEFAULT_TANK.length / 2 - DEFAULT_TANK.glass;
    const halfD = DEFAULT_TANK.depth / 2 - DEFAULT_TANK.glass;
    for (const item of preset.decor) {
      const procedural = parseEuphylliaId(item.assetId);
      const bounds = procedural
        ? generateEuphyllia(procedural.variant, procedural.seed, 2).bounds
        : entries.get(item.assetId)?.bounds;
      if (!bounds) throw new Error(`${item.assetId} has no bounds`);
      const slack = procedural || kinds.get(item.assetId) === 'anemone' ? 0.05 : 0;
      const [x0 = 0, , z0 = 0] = bounds.min;
      const [x1 = 0, , z1 = 0] = bounds.max;
      const cos = Math.cos(item.rotationY);
      const sin = Math.sin(item.rotationY);
      let reachX = 0;
      let reachZ = 0;
      for (const [x, z] of [
        [x0, z0],
        [x0, z1],
        [x1, z0],
        [x1, z1],
      ] as const) {
        reachX = Math.max(reachX, Math.abs(x * cos + z * sin));
        reachZ = Math.max(reachZ, Math.abs(-x * sin + z * cos));
      }
      expect(Math.abs(item.position[0]) + reachX * item.scale + slack, item.assetId).toBeLessThan(
        halfL,
      );
      expect(Math.abs(item.position[2]) + reachZ * item.scale + slack, item.assetId).toBeLessThan(
        halfD,
      );
    }
  });

  it('keeps corals and the anemone from intersecting each other or the other decor', () => {
    interface Box {
      id: string;
      corners: [number, number][];
      y0: number;
      y1: number;
      coral: boolean;
      rock: boolean;
      slack: number;
    }
    const boxes: Box[] = preset.decor.map((item) => {
      const procedural = parseEuphylliaId(item.assetId);
      const bounds = procedural
        ? generateEuphyllia(procedural.variant, procedural.seed, 2).bounds
        : entries.get(item.assetId)?.bounds;
      if (!bounds) throw new Error(`${item.assetId} has no bounds`);
      const [x0 = 0, y0 = 0, z0 = 0] = bounds.min;
      const [x1 = 0, y1 = 0, z1 = 0] = bounds.max;
      const cos = Math.cos(item.rotationY);
      const sin = Math.sin(item.rotationY);
      const corners = (
        [
          [x0, z0],
          [x0, z1],
          [x1, z1],
          [x1, z0],
        ] as [number, number][]
      ).map(
        ([x, z]) =>
          [
            item.position[0] + (x * cos + z * sin) * item.scale,
            item.position[2] + (-x * sin + z * cos) * item.scale,
          ] as [number, number],
      );
      const kind = procedural ? 'coral' : kinds.get(item.assetId);
      return {
        id: item.assetId,
        corners,
        y0: item.position[1] + y0 * item.scale,
        y1: item.position[1] + y1 * item.scale,
        coral: kind === 'coral' || kind === 'anemone',
        rock: kind === 'rock',
        slack: procedural || kind === 'anemone' ? 0.02 : 0,
      };
    });
    const overlapDepth = (a: [number, number][], b: [number, number][]): number => {
      let depth = Infinity;
      for (const poly of [a, b]) {
        for (let i = 0; i < 4; i++) {
          const [px = 0, pz = 0] = poly[i] ?? [];
          const [qx = 0, qz = 0] = poly[(i + 1) % 4] ?? [];
          const nx = pz - qz;
          const nz = qx - px;
          const len = Math.hypot(nx, nz);
          const project = (c: [number, number][]) => {
            const v = c.map(([x, z]) => (x * nx + z * nz) / len);
            return [Math.min(...v), Math.max(...v)] as const;
          };
          const [a0, a1] = project(a);
          const [b0, b1] = project(b);
          depth = Math.min(depth, Math.min(a1, b1) - Math.max(a0, b0));
        }
      }
      return depth;
    };
    const tolerance = 0.005;
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b || (!a.coral && !b.coral) || a.rock || b.rock) continue;
        const vertical = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (vertical <= tolerance) continue;
        const depth = overlapDepth(a.corners, b.corners) + a.slack + b.slack;
        if (depth > tolerance) overlaps.push(`${a.id} vs ${b.id} (${depth.toFixed(3)} m)`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('seats rocks, corals and the anemone on the substrate', () => {
    for (const item of preset.decor) {
      const kind = parseEuphylliaId(item.assetId) ? 'coral' : kinds.get(item.assetId);
      if (kind !== 'rock' && kind !== 'coral' && kind !== 'anemone') continue;
      const ground = substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
      if (item.assetId === 'coast-rocks-05' && item.position[1] > ground + 0.05) continue;
      expect(Math.abs(item.position[1] - ground), item.assetId).toBeLessThan(0.03);
    }
  });
});

describe('loadPreset', () => {
  it('loads a preset for every biome', () => {
    expect(loadPreset('freshwater').biome).toBe('freshwater');
    expect(loadPreset('reef').biome).toBe('reef');
  });
});

describe.each(['freshwater', 'reef'] as const)('%s preset glass clearance at load', (biome) => {
  const preset = loadPreset(biome);
  const entries = new Map(catalog.assets.map((a) => [a.id, a]));
  const extent = glassExtent(DEFAULT_TANK);
  const current = preset.current ?? DEFAULT_CURRENT;

  it('passes the checks the scene runs while loading', () => {
    for (const item of preset.decor) {
      const procedural = parseEuphylliaId(item.assetId);
      if (procedural) {
        const { bounds } = generateEuphyllia(procedural.variant, procedural.seed, 2);
        expect(
          () => checkEuphylliaClearOfGlass(item, bounds, current, extent),
          item.assetId,
        ).not.toThrow();
      } else if (kinds.get(item.assetId) === 'anemone') {
        const b = entries.get(item.assetId)?.bounds;
        if (!b) throw new Error(`${item.assetId} has no bounds`);
        const [x0 = 0, y0 = 0, z0 = 0] = b.min;
        const [x1 = 0, y1 = 0, z1 = 0] = b.max;
        const entry: CatalogEntry = {
          id: item.assetId,
          kind: 'anemone',
          lods: [],
          bounds: { min: [x0, y0, z0], max: [x1, y1, z1] },
        };
        expect(() => checkClearOfGlass(entry, item, current, extent), item.assetId).not.toThrow();
      }
    }
  });
});

describe('cichlid preset', () => {
  const preset = loadPreset('cichlid');
  const entries = new Map(catalog.assets.map((a) => [a.id, a]));

  it('is rockwork on sand with caves, shells and no plants', () => {
    expect(preset.biome).toBe('cichlid');
    expect(kinds.get(preset.substrate?.assetId ?? '')).toBe('substrate');
    expect(preset.plantPatches).toHaveLength(0);
    const ids = preset.decor.map((d) => d.assetId);
    expect(ids).toContain('rock-pile-cave');
    expect(ids).toContain('rock-pile-stack');
    expect(ids.filter((id) => id === 'neothauma-shell').length).toBeGreaterThanOrEqual(5);
    expect(ids.filter((id) => kinds.get(id) === 'rock').length).toBeGreaterThanOrEqual(5);
  });

  it('uses only decor the biome allows', () => {
    for (const item of preset.decor) {
      expect(isDecorAssetForBiome('cichlid', item.assetId), item.assetId).toBe(true);
    }
  });

  it('seats rocks and shells on the sand', () => {
    for (const item of preset.decor) {
      const ground = substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
      expect(Math.abs(item.position[1] - ground), item.assetId).toBeLessThan(0.03);
    }
  });

  it('keeps every footprint inside the glass', () => {
    const halfL = DEFAULT_TANK.length / 2 - DEFAULT_TANK.glass;
    const halfD = DEFAULT_TANK.depth / 2 - DEFAULT_TANK.glass;
    for (const item of preset.decor) {
      const bounds = entries.get(item.assetId)?.bounds;
      if (!bounds) throw new Error(`${item.assetId} has no bounds`);
      const [x0 = 0, , z0 = 0] = bounds.min;
      const [x1 = 0, , z1 = 0] = bounds.max;
      const cos = Math.cos(item.rotationY);
      const sin = Math.sin(item.rotationY);
      let reachX = 0;
      let reachZ = 0;
      for (const [x, z] of [
        [x0, z0],
        [x0, z1],
        [x1, z0],
        [x1, z1],
      ] as const) {
        reachX = Math.max(reachX, Math.abs(x * cos + z * sin));
        reachZ = Math.max(reachZ, Math.abs(-x * sin + z * cos));
      }
      expect(Math.abs(item.position[0]) + reachX * item.scale, item.assetId).toBeLessThan(halfL);
      expect(Math.abs(item.position[2]) + reachZ * item.scale, item.assetId).toBeLessThan(halfD);
    }
  });
});

describe.each(['blackwater', 'mangrove'] as const)('%s preset', (biome) => {
  const preset = loadPreset(biome);
  const entries = new Map(catalog.assets.map((a) => [a.id, a]));

  it('uses only decor the biome allows and shipped substrates', () => {
    expect(preset.biome).toBe(biome);
    expect(kinds.get(preset.substrate?.assetId ?? '')).toBe('substrate');
    expect(kinds.get(preset.substrate?.accentAssetId ?? '')).toBe('substrate');
    for (const item of preset.decor) {
      expect(isDecorAssetForBiome(biome, item.assetId), item.assetId).toBe(true);
    }
    for (const patch of preset.plantPatches) {
      expect(kinds.get(patch.assetId), patch.assetId).toBe('plant');
    }
  });

  it('seats wood, rock and roots on the substrate', () => {
    for (const item of preset.decor) {
      const ground = substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
      expect(Math.abs(item.position[1] - ground), item.assetId).toBeLessThan(0.03);
    }
  });

  it('keeps every footprint and every top inside the tank', () => {
    const halfL = DEFAULT_TANK.length / 2 - DEFAULT_TANK.glass;
    const halfD = DEFAULT_TANK.depth / 2 - DEFAULT_TANK.glass;
    for (const item of preset.decor) {
      const bounds = entries.get(item.assetId)?.bounds;
      if (!bounds) throw new Error(`${item.assetId} has no bounds`);
      const [x0 = 0, , z0 = 0] = bounds.min;
      const [x1 = 0, y1 = 0, z1 = 0] = bounds.max;
      const cos = Math.cos(item.rotationY);
      const sin = Math.sin(item.rotationY);
      let reachX = 0;
      let reachZ = 0;
      for (const [x, z] of [
        [x0, z0],
        [x0, z1],
        [x1, z0],
        [x1, z1],
      ] as const) {
        reachX = Math.max(reachX, Math.abs(x * cos + z * sin));
        reachZ = Math.max(reachZ, Math.abs(-x * sin + z * cos));
      }
      expect(Math.abs(item.position[0]) + reachX * item.scale, item.assetId).toBeLessThan(halfL);
      expect(Math.abs(item.position[2]) + reachZ * item.scale, item.assetId).toBeLessThan(halfD);
      expect(item.position[1] + y1 * item.scale, item.assetId).toBeLessThan(
        DEFAULT_TANK.height - DEFAULT_TANK.freeboard - 0.02,
      );
    }
  });
});

describe('blackwater and mangrove composition', () => {
  it('blackwater is wood and leaf litter with no rock', () => {
    const ids = loadPreset('blackwater').decor.map((d) => d.assetId);
    expect(ids.filter((id) => kinds.get(id) === 'driftwood').length).toBeGreaterThanOrEqual(4);
    expect(ids.filter((id) => id === 'oak-leaf-card').length).toBeGreaterThanOrEqual(8);
    expect(ids.some((id) => kinds.get(id) === 'rock')).toBe(false);
  });

  it('keeps overlapping leaf cards at distinct heights so they cannot z-fight', () => {
    const bounds = catalog.assets.find((a) => a.id === 'oak-leaf-card')?.bounds;
    if (!bounds) throw new Error('oak-leaf-card has no bounds');
    const half = ((bounds.max[0] ?? 0) - (bounds.min[0] ?? 0)) / 2;
    type Card = ReturnType<typeof loadPreset>['decor'][number];
    const overlap = (a: Card, b: Card): boolean => {
      const dx = b.position[0] - a.position[0];
      const dz = b.position[2] - a.position[2];
      for (const angle of [a.rotationY, b.rotationY]) {
        const ux = Math.cos(angle);
        const uz = -Math.sin(angle);
        for (const [axX, axZ] of [
          [ux, uz],
          [-uz, ux],
        ] as const) {
          const reach = (c: Card): number => {
            const cos = Math.cos(c.rotationY);
            const sin = Math.sin(c.rotationY);
            return (
              half * c.scale * (Math.abs(axX * cos - axZ * sin) + Math.abs(axX * sin + axZ * cos))
            );
          };
          if (Math.abs(dx * axX + dz * axZ) >= reach(a) + reach(b)) return false;
        }
      }
      return true;
    };
    const cards = loadPreset('blackwater').decor.filter((d) => d.assetId === 'oak-leaf-card');
    for (const card of cards) {
      const ground = substrateHeight(DEFAULT_TANK, card.position[0], card.position[2]);
      expect(card.position[1], 'leaf card centre must sit above the sand').toBeGreaterThan(ground);
    }
    for (const [i, a] of cards.entries()) {
      for (const b of cards.slice(i + 1)) {
        if (!overlap(a, b)) continue;
        expect(
          Math.abs(a.position[1] - b.position[1]),
          `cards ${i} and ${cards.indexOf(b)}`,
        ).toBeGreaterThanOrEqual(0.004);
      }
    }
  });

  it('mangrove is prop roots and stumps on mud, with propagules', () => {
    const preset = loadPreset('mangrove');
    const ids = preset.decor.map((d) => d.assetId);
    expect(preset.substrate?.assetId).toBe('brown-mud-03');
    expect(ids.filter((id) => id === 'mangrove-prop-roots').length).toBeGreaterThanOrEqual(5);
    expect(ids.filter((id) => id === 'mangrove-stump')).toHaveLength(2);
    expect(ids).toContain('mangrove-propagule');
  });
});
