import { describe, expect, it } from 'vitest';
import {
  biomeSchema,
  sampleFloor,
  speciesSchema,
  tankWaterBounds,
  tankWaterTop,
} from '@aquarium/shared';
import { BEHAVIOUR, World } from '@aquarium/sim';
import shippedIndex from '../../public/assets/index.json';
import { DEFAULT_TANK, waterBounds } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { anemoneAnchor, type SceneAnchor } from '../scene/anemone';
import type { CatalogEntry } from '../scene/assets';
import { loadPreset } from '../scene/preset';
import { DEMO_STOCKS, demoTank, sceneAnchorsToSim } from './demoStock';

const BIOMES = biomeSchema.options;
// PLAN §2.7: the mobile tier draws at most 30 fish per tank, and the demo runs on mobile too.
const MOBILE_FISH_BUDGET = 30;

function reefAnemone(): { anchor: SceneAnchor; crownTop: number } {
  const item = loadPreset('reef').decor.find((i) => i.assetId === 'host-anemone');
  const asset = shippedIndex.assets.find((a) => a.id === 'host-anemone');
  if (item === undefined || asset?.bounds === undefined) {
    throw new Error('reef preset or asset index has no host anemone');
  }
  const [x0, y0, z0] = asset.bounds.min;
  const [x1, y1, z1] = asset.bounds.max;
  const entry: CatalogEntry = {
    id: asset.id,
    kind: 'anemone',
    lods: [],
    bounds: { min: [x0 ?? 0, y0 ?? 0, z0 ?? 0], max: [x1 ?? 0, y1 ?? 0, z1 ?? 0] },
  };
  return {
    anchor: anemoneAnchor('anemone-1', entry, item),
    crownTop: item.position[1] + (y1 ?? 0) * item.scale,
  };
}

describe.each(BIOMES)('demoTank(%s)', (biome) => {
  const stock = DEMO_STOCKS[biome];

  it('spawns the stock counts with unique ids for known species', () => {
    const { config } = demoTank(DEFAULT_TANK, 1, biome);
    const total = Object.values(stock.counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(config.fish).toHaveLength(total);
    expect(new Set(config.fish.map((f) => f.id)).size).toBe(total);
    const known = new Set(stock.species.map((s) => s.id));
    for (const spawn of config.fish) expect(known.has(spawn.species)).toBe(true);
    for (const id of Object.keys(stock.counts)) expect(known.has(id), id).toBe(true);
  });

  it('only stocks species of its own biome', () => {
    const files = import.meta.glob('../../../../content/species/*.json', {
      eager: true,
      import: 'default',
    });
    for (const species of stock.species) {
      const content = speciesSchema
        .partial({ render: true })
        .parse(files[`../../../../content/species/${species.id}.json`]);
      expect(content.biome, species.id).toBe(biome);
    }
  });

  it("runs the sim in the scene's water box", () => {
    const { space } = demoTank(DEFAULT_TANK, 1, biome).config;
    const scene = waterBounds(DEFAULT_TANK);
    const sim = tankWaterBounds(space);
    expect(sim.min[0]).toBeCloseTo(scene.min.x, 12);
    expect(sim.min[1]).toBeCloseTo(scene.min.y, 12);
    expect(sim.min[2]).toBeCloseTo(scene.min.z, 12);
    expect(sim.max[0]).toBeCloseTo(scene.max.x, 12);
    expect(sim.max[1]).toBeCloseTo(scene.max.y, 12);
    expect(sim.max[2]).toBeCloseTo(scene.max.z, 12);
  });

  it('varies body lengths by at most 8% around the species length', () => {
    const { config } = demoTank(DEFAULT_TANK, 7, biome);
    const lengths = new Map(stock.species.map((s) => [s.id, s.locomotion.bodyLengthM]));
    for (const spawn of config.fish) {
      const base = lengths.get(spawn.species) ?? Number.NaN;
      expect(Math.abs((spawn.bodyLengthM ?? Number.NaN) / base - 1)).toBeLessThanOrEqual(0.08);
    }
  });

  it('never spawns a fish longer than its species grows in content', () => {
    for (const species of stock.species) {
      expect(stock.maxLengthM[species.id], species.id).toBeGreaterThan(0);
    }
    for (let seed = 0; seed < 50; seed++) {
      for (const spawn of demoTank(DEFAULT_TANK, seed, biome).config.fish) {
        const max = stock.maxLengthM[spawn.species] ?? Number.NaN;
        expect(spawn.bodyLengthM ?? Number.NaN).toBeLessThanOrEqual(max);
      }
    }
  });

  it('passes each species diet from content to the sim', () => {
    const files = import.meta.glob('../../../../content/species/*.json', {
      eager: true,
      import: 'default',
    });
    for (const species of stock.species) {
      const raw = files[`../../../../content/species/${species.id}.json`];
      const content = speciesSchema.partial({ render: true }).parse(raw);
      expect(species, species.id).toMatchObject({ lifecycle: { diet: content.lifecycle.diet } });
    }
  });

  it('is deterministic per seed', () => {
    const a = demoTank(DEFAULT_TANK, 42, biome).config.fish.map((f) => f.bodyLengthM);
    const b = demoTank(DEFAULT_TANK, 42, biome).config.fish.map((f) => f.bodyLengthM);
    const c = demoTank(DEFAULT_TANK, 43, biome).config.fish.map((f) => f.bodyLengthM);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('stocks every schooling species at least at its content minGroup', () => {
    const files = import.meta.glob('../../../../content/species/*.json', {
      eager: true,
      import: 'default',
    });
    const schooling = stock.species.flatMap((species) => {
      const raw = files[`../../../../content/species/${species.id}.json`];
      const { schooling } = speciesSchema.partial({ render: true }).parse(raw).behaviour;
      return schooling === undefined ? [] : [{ id: species.id, minGroup: schooling.minGroup }];
    });
    if (biome === 'freshwater') {
      expect(schooling.map((s) => s.id)).toEqual(
        expect.arrayContaining(['neon-tetra', 'bronze-corydoras']),
      );
    } else {
      expect(schooling.map((s) => s.id)).toContain('banggai-cardinalfish');
    }
    const spawned = demoTank(DEFAULT_TANK, 1, biome).config.fish;
    for (const { id, minGroup } of schooling) {
      expect(stock.counts[id] ?? 0, id).toBeGreaterThanOrEqual(minGroup);
      expect(spawned.filter((f) => f.species === id).length, id).toBeGreaterThanOrEqual(minGroup);
    }
  });

  it('stays within the mobile fish budget', () => {
    expect(demoTank(DEFAULT_TANK, 1, biome).config.fish.length).toBeLessThanOrEqual(
      MOBILE_FISH_BUDGET,
    );
  });

  it('builds a world the sim accepts', () => {
    expect(() => new World(demoTank(DEFAULT_TANK, 3, biome).config)).not.toThrow();
  });
});

describe('reef stock', () => {
  it('keeps freshwater and reef species apart', () => {
    const fresh = new Set(DEMO_STOCKS.freshwater.species.map((s) => s.id));
    for (const s of DEMO_STOCKS.reef.species) expect(fresh.has(s.id), s.id).toBe(false);
  });

  it('has a clownfish pair, a tang, a royal gramma and banggai', () => {
    const { counts } = DEMO_STOCKS.reef;
    expect(counts['ocellaris-clownfish']).toBe(2);
    expect((counts['yellow-tang'] ?? 0) + (counts['blue-tang'] ?? 0)).toBeGreaterThanOrEqual(1);
    expect(counts['royal-gramma']).toBeGreaterThanOrEqual(1);
    expect(counts['banggai-cardinalfish']).toBeGreaterThanOrEqual(1);
  });
});

describe('demo tank floor', () => {
  const t = DEFAULT_TANK;
  const { space } = demoTank(t, 1, 'freshwater').config;
  const flatFloor = t.glass + Math.max(t.substrateFront, t.substrateBack) + 0.01;

  it("follows the scene's sloped, duned sand to under half a millimetre", () => {
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 20; j++) {
        const x = -0.58 + (1.16 * i) / 40;
        const z = -0.23 + (0.46 * j) / 20;
        worst = Math.max(worst, Math.abs(sampleFloor(space, x, z) - substrateHeight(t, x, z)));
      }
    }
    expect(worst).toBeLessThan(5e-4);
  });

  it('is low at the front and high at the back, not flat at the highest point', () => {
    const front = sampleFloor(space, 0, 0.23);
    const back = sampleFloor(space, 0, -0.23);
    expect(back - front).toBeGreaterThan(0.05);
    expect(front).toBeLessThan(flatFloor - 0.05);
  });

  it('keeps corydoras on the sand down the slope, below where the flat floor held them', () => {
    const demo = demoTank(t, 11, 'freshwater');
    const world = new World(demo.config);
    const cories = demo.config.fish.flatMap((f, i) =>
      f.species === 'bronze-corydoras' ? [i] : [],
    );
    expect(cories.length).toBeGreaterThan(0);
    const heights: number[] = [];
    let belowFlat = 0;
    for (let step = 0; step < 6000; step++) {
      world.step();
      if (step < 600 || step % 5 !== 0) continue;
      for (const i of cories) {
        const x = world.position[i * 3] ?? 0;
        const y = world.position[i * 3 + 1] ?? 0;
        const z = world.position[i * 3 + 2] ?? 0;
        const h = y - substrateHeight(t, x, z);
        expect(h).toBeGreaterThan(0);
        heights.push(h);
        if (y < flatFloor) belowFlat++;
      }
    }
    heights.sort((a, b) => a - b);
    expect(heights[Math.floor(heights.length / 2)]).toBeLessThan(0.02);
    expect(belowFlat / heights.length).toBeGreaterThan(0.8);
  });
});

describe('sceneAnchorsToSim', () => {
  const demo = demoTank(DEFAULT_TANK, 5, 'reef');
  const { space } = demo.config;
  const top = tankWaterTop(space);

  it('passes an anchor in free water through unchanged', () => {
    const scene: SceneAnchor = {
      id: 'a',
      kind: 'anemone',
      position: [0.1, 0.25, -0.05],
      radius: 0.04,
    };
    expect(sceneAnchorsToSim([scene], demo)).toEqual([
      { id: 'a', kind: 'anemone', position: [0.1, 0.25, -0.05], radius: 0.04 },
    ]);
  });

  it('lifts an anchor sunk into the sand until its sphere clears it', () => {
    const low: SceneAnchor = { id: 'low', kind: 'anemone', position: [0, 0.02, 0], radius: 0.03 };
    const [sim] = sceneAnchorsToSim([low], demo);
    expect(sim?.position[1]).toBeCloseTo(sampleFloor(space, 0, 0) + 0.03, 12);
  });

  it('keeps an anchor at the surface inside the water', () => {
    const high: SceneAnchor = { id: 'top', kind: 'cave', position: [0, 0.6, 0], radius: 0.03 };
    const [sim] = sceneAnchorsToSim([high], demo);
    expect(sim?.position[1]).toBeCloseTo(top - 0.03, 12);
  });

  it('shrinks a radius too large for the water column', () => {
    const big: SceneAnchor = { id: 'big', kind: 'anemone', position: [0, 0.2, 0], radius: 1 };
    const [sim] = sceneAnchorsToSim([big], demo);
    const ground = sampleFloor(space, 0, 0);
    expect(sim?.radius).toBeCloseTo((top - ground) / 4, 12);
    expect(sim?.position[1]).toBeGreaterThan(ground);
    expect(sim?.position[1]).toBeLessThan(top);
  });

  it('returns no anchors for a scene without any', () => {
    expect(sceneAnchorsToSim([], demo)).toEqual([]);
  });

  it('puts the reef clownfish pair in the preset anemone', () => {
    const { anchor, crownTop } = reefAnemone();
    const simAnchors = sceneAnchorsToSim([anchor], demo);
    const sim = simAnchors[0];
    if (sim === undefined) throw new Error('no converted anchor');
    expect(sim.position).toEqual(anchor.position);
    expect(sim.position[1] - sim.radius).toBeLessThanOrEqual(crownTop);
    const world = new World(demo.config);
    world.setAnchors(simAnchors);
    const clowns = demo.config.fish.flatMap((f, i) =>
      f.species === 'ocellaris-clownfish' ? [i] : [],
    );
    expect(clowns).toHaveLength(2);
    const length = Math.max(...clowns.map((i) => world.bodyLength[i] ?? 0));
    const leash = sim.radius + (BEHAVIOUR.hostLeashBodyLengths + 1) * length;
    let close = 0;
    let samples = 0;
    for (let t = 0; t < 3000; t++) {
      world.step();
      if (t < 600) continue;
      for (const i of clowns) {
        const d = Math.hypot(
          (world.position[i * 3] ?? 0) - sim.position[0],
          (world.position[i * 3 + 1] ?? 0) - sim.position[1],
          (world.position[i * 3 + 2] ?? 0) - sim.position[2],
        );
        if (d < leash) close++;
        samples++;
      }
    }
    expect(close / samples).toBeGreaterThan(0.75);
  });
});
