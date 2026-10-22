import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decorLayoutSchema,
  type CapsuleCollider,
  type Collider,
  type DecorItem,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import type { Anchor } from './behaviour.ts';
import { ARCHETYPES, blueTang, FoodRain, SLOPED_SPACE, spawnMany, yellowTang } from './fixtures.ts';
import { STEP_HZ, World } from './world.ts';

const LONG = 120_000;
// Reads the reef preset (content/presets/reef.json) and the asset catalogue bounds
// (apps/web/public/assets/index.json), so moving a rock in either is checked here.
const root = join(import.meta.dirname, '../../..');

interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

interface IndexEntry {
  readonly id: string;
  readonly kind: string;
  readonly bounds?: Bounds;
}

type Spot = readonly [string, number, number, number];
type Vec3 = readonly [number, number, number];

const preset = JSON.parse(readFileSync(join(root, 'content/presets/reef.json'), 'utf8')) as {
  decor: unknown;
};
const layout = decorLayoutSchema.parse(preset.decor);
const catalog = new Map(
  (
    JSON.parse(readFileSync(join(root, 'apps/web/public/assets/index.json'), 'utf8')) as {
      assets: IndexEntry[];
    }
  ).assets.map((a) => [a.id, a]),
);

const HARD_KINDS = new Set(['rock', 'coral', 'decor']);

interface EuphylliaShape {
  readonly radius: number;
  /** Height of the upper sphere centre above the foot. */
  readonly top: number;
  /** Drift [x, z] of the upper sphere centre from the lower one, in the colony's own frame. */
  readonly lean: readonly [number, number];
}

/**
 * Euphyllia colonies are generated in the scene and have no catalogue bounds. These are the
 * scene's capsules for the preset's two colonies at scale 1 (`euphylliaCapsule` in
 * apps/web/src/scene/euphyllia.ts), from `generateEuphyllia(variant, seed, 2).bounds`: radius 0.6
 * times the horizontal footprint, top 0.85 times the height, and the top sphere drifted by the
 * mesh's horizontal bounds centre, which leans it toward the polyps.
 */
const EUPHYLLIA: Readonly<Record<string, EuphylliaShape>> = {
  'euphyllia-hammer-3': { radius: 0.05299, top: 0.10125, lean: [-0.01052, 0.01817] },
  'euphyllia-torch-8': { radius: 0.06325, top: 0.11817, lean: [-0.02483, 0.02139] },
};

/** A colony's capsule as clients send it: the lean turns with the item and grows with its scale. */
function euphylliaCapsule(id: string, item: DecorItem): CapsuleCollider {
  const shape = EUPHYLLIA[item.assetId];
  if (shape === undefined) {
    throw new Error(`reef preset colony "${item.assetId}" has no hand-built euphyllia capsule`);
  }
  const [x, y, z] = item.position;
  const s = item.scale;
  const c = Math.cos(item.rotationY);
  const sn = Math.sin(item.rotationY);
  const [lx, lz] = shape.lean;
  return {
    id,
    hard: false,
    kind: 'capsule',
    a: [x, y + shape.radius * s, z],
    b: [x + (lx * c + lz * sn) * s, y + shape.top * s, z + (-lx * sn + lz * c) * s],
    radius: shape.radius * s,
  };
}

/**
 * The reef preset's colliders as the scene builds them, with every rock, coral and shell's
 * convex hull replaced by the rotated box of its bounds. The box contains the hull, so a fish
 * that reaches food past the boxes also reaches it past the real rock.
 */
function reefColliders(): { decor: Collider[]; anchors: Anchor[] } {
  const decor: Collider[] = [];
  const anchors: Anchor[] = [];
  layout.forEach((item: DecorItem, n) => {
    const id = `${item.assetId}-${n}`;
    const [x, y, z] = item.position;
    if (item.assetId.startsWith('euphyllia-')) {
      decor.push(euphylliaCapsule(id, item));
      return;
    }
    const entry = catalog.get(item.assetId);
    if (entry?.bounds === undefined) {
      throw new Error(`reef preset item "${item.assetId}" has no bounds in the asset index`);
    }
    const { min, max } = entry.bounds;
    const s = item.scale;
    if (entry.kind === 'anemone') {
      const spread = Math.max(-min[0], max[0], -min[2], max[2]) * s;
      const r = spread * 0.45;
      const top = Math.max(r, max[1] * s * 0.8);
      decor.push({
        id,
        hard: false,
        kind: 'capsule',
        a: [x, y + r, z],
        b: [x, y + top, z],
        radius: r,
      });
      anchors.push({ id, kind: 'anemone', position: [x, y + max[1] * s * 0.5, z], radius: r });
      return;
    }
    if (!HARD_KINDS.has(entry.kind)) return;
    const cx = ((min[0] + max[0]) / 2) * s;
    const cz = ((min[2] + max[2]) / 2) * s;
    const c = Math.cos(item.rotationY);
    const sn = Math.sin(item.rotationY);
    decor.push({
      id,
      hard: true,
      kind: 'box',
      center: [x + cx * c + cz * sn, y + ((min[1] + max[1]) / 2) * s, z - cx * sn + cz * c],
      halfExtents: [
        ((max[0] - min[0]) / 2) * s,
        ((max[1] - min[1]) / 2) * s,
        ((max[2] - min[2]) / 2) * s,
      ],
      rotationY: item.rotationY,
      rounding: 0,
    });
  });
  return { decor, anchors };
}

const REEF = reefColliders();

/** Free water above the reef, mid-tank, where the fish start. */
const STARTS: readonly (readonly [number, number, number])[] = [
  [-0.25, 0.38, 0.05],
  [0.1, 0.4, -0.05],
];

/**
 * Spawns in the bare tank and then adds the reef: the preset leaves too little open water for
 * the random spawn's one-body-length pad, and fixed starts keep every seed's route comparable.
 */
function reefTank(seed: number, species: string, starts: typeof STARTS): World {
  const w = new World({
    seed,
    space: SLOPED_SPACE,
    species: ARCHETYPES,
    fish: spawnMany(species, starts.length),
  });
  w.setDecor(REEF.decor);
  w.setAnchors(REEF.anchors);
  starts.forEach(([x, y, z], i) => {
    w.position[i * 3] = x;
    w.position[i * 3 + 1] = y;
    w.position[i * 3 + 2] = z;
    expect(w.bodyClearance(i)).toBeGreaterThan(0);
  });
  return w;
}

interface Grazing {
  /** Each fish's first-bite step, or -1. */
  readonly first: number[];
  readonly contacts: number;
  readonly fishSteps: number;
}

/** Steps the tank with a nori clip at (x, y, z), grazing on after the first bites. */
function graze(w: World, x: number, y: number, z: number, steps: number): Grazing {
  const rain = new FoodRain(w.basin);
  const nori = rain.place('nori', x, y, z);
  const first = Array.from({ length: w.count }, () => -1);
  for (let t = 0; t < steps; t++) {
    rain.feed(w);
    w.step();
    const events = w.takeAteEvents();
    rain.eat(events);
    for (const e of events) {
      const i = w.fishIds.indexOf(e.fishId);
      if (e.foodId === nori && first[i] === -1) first[i] = t;
    }
  }
  return { first, contacts: w.contacts, fishSteps: w.count * steps };
}

describe('a leaning euphyllia on the reef preset', () => {
  const colony = REEF.decor.find(
    (c): c is CapsuleCollider => c.id.startsWith('euphyllia-torch-') && c.kind === 'capsule',
  );
  if (colony === undefined) throw new Error('the reef preset lost its torch euphyllia');
  const { a, b, radius } = colony;
  const drift = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const ux = (b[0] - a[0]) / drift;
  const uz = (b[2] - a[2]) / drift;
  const SEEDS = [1, 2, 3];
  const STEPS = STEP_HZ / 3;

  function startAt(decor: readonly Collider[], [x, y, z]: Vec3, seed: number): World {
    const w = new World({
      seed,
      space: SLOPED_SPACE,
      species: ARCHETYPES,
      fish: spawnMany('royal-gramma', 1),
    });
    w.setDecor(decor);
    w.setAnchors(REEF.anchors);
    w.position[0] = x;
    w.position[1] = y;
    w.position[2] = z;
    // Heading across the lean, so the body samples sit level with the point on both sides.
    w.yaw[0] = Math.atan2(-uz, ux);
    expect(w.bodyClearance(0)).toBeGreaterThan(0);
    return w;
  }

  // A fish feels a plant once its centre is within its own radius of the surface.
  const reach = startAt(REEF.decor, [a[0], 0.4, a[2]], 1).radius[0] ?? NaN;
  // Level with the top sphere, on the line of the lean. Each point is half the drift inside the
  // fish's reach of one capsule and half the drift beyond it of the other: the leaning capsule on
  // the side it leans to, and a vertical capsule on the same foot on the side it leans from.
  const out = radius + reach + drift / 2;
  const leanSide: Vec3 = [a[0] + ux * out, b[1], a[2] + uz * out];
  const fromSide: Vec3 = [a[0] - ux * (out - drift), b[1], a[2] - uz * (out - drift)];

  /** How far the fish has moved along the lean after `STEPS`. */
  function along(decor: readonly Collider[], start: Vec3, seed: number): number {
    const w = startAt(decor, start, seed);
    for (let t = 0; t < STEPS; t++) w.step();
    return ((w.position[0] ?? 0) - start[0]) * ux + ((w.position[2] ?? 0) - start[2]) * uz;
  }

  it('leans by more than the margin either test point keeps', () => {
    expect(drift).toBeGreaterThan(0.02);
    expect(Math.hypot(leanSide[0] - a[0], leanSide[2] - a[2]) - radius).toBeGreaterThan(reach);
    expect(Math.hypot(fromSide[0] - a[0], fromSide[2] - a[2]) - radius).toBeLessThan(reach);
  });

  it('pushes a fish on the side it leans to away along the lean', () => {
    const bare = REEF.decor.filter((c) => c !== colony);
    for (const seed of SEEDS) {
      const w = startAt(REEF.decor, leanSide, seed);
      w.step();
      expect(w.plantContacts).toBe(1);
      expect(along(REEF.decor, leanSide, seed)).toBeGreaterThan(along(bare, leanSide, seed));
    }
  });

  it('leaves a fish on the side it leans from untouched', () => {
    // Rock backs the colony on this side, so only the preset's soft colliders are placed.
    const soft = REEF.decor.filter((c) => !c.hard);
    for (const seed of SEEDS) {
      const w = startAt(soft, fromSide, seed);
      w.step();
      expect(w.plantContacts).toBe(0);
    }
  });
});

describe('tangs on the reef preset', { timeout: LONG }, () => {
  // Room for one abandoned approach (pursuit timeout, then ignoring the clip) and a second go.
  const BOUND_STEPS = 30 * STEP_HZ;
  const SEEDS = [1, 2, 3];
  // A lone tang's approach path is chaotic in the rock layout, so more seeds catch a station it
  // cannot face from (#232) that three happen to miss.
  const LONE_SEEDS = [1, 2, 3, 4, 5, 6];
  // Contacts per fish-step. Turning on the spot in a corner brushes the glass now and then, and
  // a second tang squeezing past the one at the clip more often; a fish pressed against the pane,
  // as in #89, touches it nearly every step. About 1.5 times the rates measured.
  const LONE_CONTACT_RATE = 2.75e-3;
  const PAIR_CONTACT_RATE = 6e-3;
  const { minX, maxX, minZ, maxZ } = reefTank(1, yellowTang.id, STARTS).basin;
  // Nori clipped 2 cm off the glass.
  const inset = 0.02;
  const pane: Spot = ['right pane over the rock', maxX - inset, 0.3, -0.1];
  const corners: Spot[] = [
    ['back right corner', maxX - inset, 0.3, minZ + inset],
    ['back left corner', minX + inset, 0.3, minZ + inset],
    ['front right corner', maxX - inset, 0.3, maxZ - inset],
    ['front left corner', minX + inset, 0.3, maxZ - inset],
  ];

  for (const sp of [blueTang, yellowTang]) {
    it(`has a lone ${sp.id} reach nori on the glass and in every corner`, () => {
      const missed: string[] = [];
      let contacts = 0;
      let fishSteps = 0;
      for (const [name, x, y, z] of [pane, ...corners]) {
        for (const start of STARTS) {
          for (const seed of LONE_SEEDS) {
            const run = graze(reefTank(seed, sp.id, [start]), x, y, z, BOUND_STEPS);
            if (run.first[0] === -1) missed.push(`${name}, start ${start.join()}, seed ${seed}`);
            contacts += run.contacts;
            fishSteps += run.fishSteps;
          }
        }
      }
      expect(missed).toEqual([]);
      expect(contacts / fishSteps).toBeLessThan(LONE_CONTACT_RATE);
    });

    it(`has a pair of ${sp.id}s share a clip over the rock and work the corners`, () => {
      const missed: string[] = [];
      let contacts = 0;
      let fishSteps = 0;
      for (const seed of SEEDS) {
        const [name, x, y, z] = pane;
        const shared = graze(reefTank(seed, sp.id, STARTS), x, y, z, BOUND_STEPS);
        if (shared.first.includes(-1)) {
          missed.push(`${name}, seed ${seed}: first bites ${shared.first.join()}`);
        }
        contacts += shared.contacts;
        fishSteps += shared.fishSteps;
        // A corner has room for one tang facing the clip, and tangs contest food, so only the
        // clip being worked is required there.
        for (const [corner, cx, cy, cz] of corners) {
          const run = graze(reefTank(seed, sp.id, STARTS), cx, cy, cz, BOUND_STEPS);
          if (run.first.every((t) => t === -1)) missed.push(`${corner}, seed ${seed}: no bites`);
          contacts += run.contacts;
          fishSteps += run.fishSteps;
        }
      }
      expect(missed).toEqual([]);
      expect(contacts / fishSteps).toBeLessThan(PAIR_CONTACT_RATE);
    });
  }
});
