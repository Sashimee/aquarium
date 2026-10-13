import { describe, expect, it } from 'vitest';
import { biomeSchema, speciesSchema } from '@aquarium/shared';
import { BEHAVIOUR, World } from '@aquarium/sim';
import shippedIndex from '../../public/assets/index.json';
import { DEFAULT_TANK, WATER_INSET } from '../engine/tank/dimensions';
import { anemoneAnchor, type SceneAnchor } from '../scene/anemone';
import type { CatalogEntry } from '../scene/assets';
import { loadPreset } from '../scene/preset';
import { DEMO_STOCKS, demoTank, sceneAnchorsToSim } from './demoStock';

const BIOMES = biomeSchema.options;

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

  it('fits the sim tank inside the water above the substrate', () => {
    const { config, offset } = demoTank(DEFAULT_TANK, 1, biome);
    const t = DEFAULT_TANK;
    expect(config.tank.width).toBeCloseTo(t.length - 2 * (t.glass + WATER_INSET), 9);
    expect(config.tank.depth).toBeCloseTo(t.depth - 2 * (t.glass + WATER_INSET), 9);
    const floorY = offset[1];
    expect(floorY).toBeGreaterThan(t.glass + Math.max(t.substrateFront, t.substrateBack));
    expect(floorY + config.tank.height).toBeCloseTo(t.height - t.freeboard, 9);
    expect(config.tank.height).toBeGreaterThan(0);
    expect(offset[0]).toBe(0);
    expect(offset[2]).toBe(0);
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

describe('sceneAnchorsToSim', () => {
  const demo = demoTank(DEFAULT_TANK, 5, 'reef');
  const floorY = demo.offset[1];
  const { height } = demo.config.tank;

  it('moves an anchor in free water down by the sim floor height', () => {
    const scene: SceneAnchor = {
      id: 'a',
      kind: 'anemone',
      position: [0.1, 0.25, -0.05],
      radius: 0.04,
    };
    const [sim] = sceneAnchorsToSim([scene], demo);
    expect(sim?.id).toBe('a');
    expect(sim?.kind).toBe('anemone');
    expect(sim?.radius).toBe(0.04);
    expect(sim?.position[0]).toBe(0.1);
    expect(sim?.position[1]).toBeCloseTo(0.25 - floorY, 12);
    expect(sim?.position[2]).toBe(-0.05);
  });

  it('lifts an anchor below the sim floor until its sphere clears it', () => {
    const low: SceneAnchor = { id: 'low', kind: 'anemone', position: [0, 0.05, 0], radius: 0.03 };
    const [sim] = sceneAnchorsToSim([low], demo);
    expect(sim?.position[1]).toBeCloseTo(0.03, 12);
  });

  it('keeps an anchor at the surface inside the water', () => {
    const top: SceneAnchor = { id: 'top', kind: 'cave', position: [0, 0.6, 0], radius: 0.03 };
    const [sim] = sceneAnchorsToSim([top], demo);
    expect(sim?.position[1]).toBeCloseTo(height - 0.03, 12);
  });

  it('shrinks a radius too large for the water column', () => {
    const big: SceneAnchor = { id: 'big', kind: 'anemone', position: [0, 0.2, 0], radius: 1 };
    const [sim] = sceneAnchorsToSim([big], demo);
    expect(sim?.radius).toBeCloseTo(height / 4, 12);
    expect(sim?.position[1]).toBeGreaterThan(0);
    expect(sim?.position[1]).toBeLessThan(height);
  });

  it('returns no anchors for a scene without any', () => {
    expect(sceneAnchorsToSim([], demo)).toEqual([]);
  });

  it('puts the reef clownfish pair on the preset anemone', () => {
    const { anchor, crownTop } = reefAnemone();
    const simAnchors = sceneAnchorsToSim([anchor], demo);
    const world = new World(demo.config);
    world.setAnchors(simAnchors);
    const sim = simAnchors[0];
    if (sim === undefined) throw new Error('no converted anchor');
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
    // Back in engine space the anchor sphere still reaches into the tentacle crown.
    const centre = sim.position[1] + floorY;
    expect(centre).toBeGreaterThanOrEqual(anchor.position[1]);
    expect(centre - sim.radius).toBeLessThanOrEqual(crownTop);
  });
});
