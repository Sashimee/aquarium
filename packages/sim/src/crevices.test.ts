import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  colliderListSchema,
  speciesContentSchema,
  tankSpaceSchema,
  type Collider,
  type TankSpace,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { findNooks, type NookField } from './nooks.ts';
import { toSimSpecies } from './species.ts';
import { bodyTurnRoom, maxFishLengthM, World } from './world.ts';

const LONG = 120_000;

interface Preset {
  readonly biome: string;
  readonly space: TankSpace;
  readonly hulls: Collider[];
  readonly decor: Collider[];
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null)
    throw new Error(`crevice fixture: ${what} is not an object`);
  return v as Record<string, unknown>;
}

function presets(file: string, keyOf: (key: string) => string): [string, Preset][] {
  const raw = record(JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')), file);
  return Object.entries(record(raw['presets'], `${file} presets`)).map(([key, v]) => {
    const p = record(v, `${file} ${key}`);
    return [
      keyOf(key),
      {
        biome: keyOf(key).split('/')[0] ?? key,
        space: tankSpaceSchema.parse(p['space']),
        hulls: colliderListSchema.parse(p['hulls']),
        decor: colliderListSchema.parse(p['decor']),
      },
    ];
  });
}

/** Fitted presets with the scene caves left out, as a player who takes the cave rock out has them. */
const PRESETS = [
  ...presets('crevices.fixture.json', (key) => key),
  ...presets('blackwater.fixture.json', (size) => `blackwater/${size}`),
];

const dir = join(import.meta.dirname, '../../../content/species');
const caveDwellers = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => speciesContentSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
  .filter((s) => {
    const sp = toSimSpecies(s);
    return sp.home === 'cave' && sp.walking === null && sp.gait !== 'forage';
  });

function field(p: Preset, layer: 'hulls' | 'decor'): NookField {
  const w = new World({ seed: 1, space: p.space, species: [], decor: p[layer], fish: [] });
  const rock = w.decorSdf;
  if (rock === null) throw new Error('the preset has no hard decor');
  return { basin: w.basin, cover: w.substrateSdf, water: w.sceneSdf, rock };
}

describe('crevices on the fitted presets', { timeout: LONG }, () => {
  const cases = PRESETS.flatMap(([key, p]) =>
    (['hulls', 'decor'] as const).flatMap((layer) =>
      caveDwellers
        .filter((s) => s.biome === p.biome)
        .flatMap((s) =>
          [s.locomotion.bodyLengthM, s.lifecycle.maxSizeM]
            .filter((length) => length < maxFishLengthM(p.space))
            .map((length) => ({ key, layer, p, id: s.id, length })),
        ),
    ),
  );

  it('covers every biome with a fixture and the reef nano at firefish length', () => {
    expect(new Set(cases.map((c) => c.p.biome))).toEqual(
      new Set(['reef', 'cichlid', 'blackwater']),
    );
    expect(cases).toContainEqual(
      expect.objectContaining({ key: 'reef/nano30', id: 'firefish', length: 0.0735 }),
    );
  });

  it.each(cases)(
    '$key, $layer, $id at $length m: putting the roomy ones first never deals fewer',
    ({ p, layer, length }) => {
      const f = field(p, layer);
      const byCover = findNooks(f, length, 0);
      const nooks = findNooks(f, length, bodyTurnRoom(length));
      expect(nooks.length).toBeGreaterThanOrEqual(byCover.length);
      for (const [k, n] of nooks.entries()) {
        expect(n.id).toBe(`nook:${k}`);
        expect(n.radius).toBeGreaterThanOrEqual(0.5 * length);
      }
    },
  );
});
