import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Vector3, type WebGPURenderer } from 'three/webgpu';
import { colliderListSchema, type Collider, type DecorItem } from '@aquarium/shared';
import { compileCollider } from '@aquarium/sim';
import { createSharedKtx2 } from '../../engine/ktx2';
import { AssetCatalog, ModelLibrary } from '../../scene/assets';
import { caveAnchor, CAVE_MOUTHS } from '../../scene/caves';
import { decorMatrix, fitCollider } from '../../scene/hardscape';
import { sceneCollidersToSim } from '../../fish/simColliders';
import { collidersFor } from './colliders';
import { item, must, spec } from './fixtures';
import { blockedMouths, shelterColliders } from './shelterColliders';
import { specsFromCatalog } from './spec';

const PUBLIC = join(__dirname, '../../../public');
const SHELTERS = ['reef-arch', 'rock-pile-cave', 'rock-pile-stack', 'neothauma-shell'] as const;
const FISH_CLEARANCE = 0.9;
const MESH_TOLERANCE_M = 0.003;

/** How far in front of the piece (local z) each mouth can sit once the parts leave the opening clear. */
const PULLED_IN_Z: Readonly<Record<(typeof SHELTERS)[number], number>> = {
  'reef-arch': 0.042,
  'rock-pile-cave': 0.165,
  'rock-pile-stack': 0.14,
  'neothauma-shell': 0.039,
};

const SWEEP_SCALES = [0.6, 1, 1.3, 1.6];
const SWEEP_ROTATIONS = Array.from({ length: Math.ceil((Math.PI * 2) / 0.02) }, (_, i) => i * 0.02);

const LOD2_SHA256: Readonly<Record<(typeof SHELTERS)[number], string>> = {
  'reef-arch': 'e3226a7eec1049cb5c00d13b4394af3d61479f4e9c5de094b7e9233a4a12df35',
  'rock-pile-cave': 'a4c910a4681fe1ca7538f8d4bca3313e953fe73540c86d3ab64e13302f899fda',
  'rock-pile-stack': '102bcc15608e280231d7767339063ab30d3bc0c5393a5c4743fb97daf1a4982b',
  'neothauma-shell': '07c541984afe9fff89b5d792c9388a583f3acb4ef9315bcd33e578227c840e48',
};

const PLACEMENTS: readonly Partial<Omit<DecorItem, 'assetId' | 'position'>>[] = [
  {},
  { rotationY: 2.2, scale: 1.3 },
];

let library: ModelLibrary;
let catalog: AssetCatalog;

beforeAll(async () => {
  const index = JSON.parse(await readFile(join(PUBLIC, 'assets/index.json'), 'utf8')) as {
    assets: ConstructorParameters<typeof AssetCatalog>[0];
  };
  catalog = new AssetCatalog(index.assets);
  vi.stubGlobal('ProgressEvent', Event);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal(
    'Request',
    class {
      constructor(readonly url: string) {}
    },
  );
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'object' && 'url' in input ? input.url : String(input);
    const bytes = await readFile(join(PUBLIC, new URL(url, 'http://x').pathname));
    return new Response(new Uint8Array(bytes));
  });
  library = new ModelLibrary(
    createSharedKtx2({
      isWebGPURenderer: true,
      hasFeature: () => false,
    } as unknown as WebGPURenderer).loader,
    catalog,
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function clearanceTo(colliders: readonly Collider[]) {
  const solids = colliders.filter((c) => c.hard).map(compileCollider);
  const normal = new Float64Array(3);
  return (p: readonly [number, number, number]): number =>
    Math.min(...solids.map((s) => s.sample(p[0], p[1], p[2], normal)));
}

function boxFor(assetId: string, placed: DecorItem): Collider[] {
  const s = spec(assetId);
  const { min, max } = s.box;
  const sc = placed.scale;
  const cos = Math.cos(placed.rotationY);
  const sin = Math.sin(placed.rotationY);
  const lx = ((min[0] + max[0]) / 2) * sc;
  const lz = ((min[2] + max[2]) / 2) * sc;
  const half: [number, number, number] = [
    ((max[0] - min[0]) / 2) * sc,
    ((max[1] - min[1]) / 2) * sc,
    ((max[2] - min[2]) / 2) * sc,
  ];
  return [
    {
      id: 'decor:box',
      hard: true,
      kind: 'box',
      center: [
        placed.position[0] + lx * cos + lz * sin,
        placed.position[1] + half[1] + min[1] * sc,
        placed.position[2] - lx * sin + lz * cos,
      ],
      halfExtents: half,
      rotationY: placed.rotationY,
      rounding: Math.min(...half) * 0.4,
    },
  ];
}

function mouthAt(assetId: (typeof SHELTERS)[number], placed: DecorItem, z: number) {
  const mouth = CAVE_MOUTHS[assetId];
  if (!mouth) throw new Error(`${assetId} has no mouth`);
  const [x, y] = mouth.position;
  const position = new Vector3(x, y, z).applyMatrix4(decorMatrix(placed));
  const facing = new Vector3(...mouth.facing).transformDirection(decorMatrix(placed));
  return { position, facing, radius: mouth.radius * placed.scale };
}

describe('shelter colliders as the decor layer reports them', () => {
  it.each(SHELTERS)('%s becomes several hard hulls that pass the shared contract', (id) => {
    const list = collidersFor('p1', spec(id), item(id, 0.2, 0.1));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.kind === 'hull' && c.hard)).toBe(true);
    expect(list.every((c) => c.id.startsWith('decor:p1'))).toBe(true);
    expect(colliderListSchema.safeParse(list).success).toBe(true);
  });

  it('keeps one hull per rock of a pile and three parts for the arch', () => {
    const count = (id: string) => collidersFor('p', spec(id), item(id, 0, 0)).length;
    expect(count('rock-pile-cave')).toBe(4);
    expect(count('rock-pile-stack')).toBe(3);
    expect(count('reef-arch')).toBe(3);
    expect(count('neothauma-shell')).toBe(1);
  });

  it('follows the piece when it is moved and turned', () => {
    const probe = (placed: DecorItem) => {
      const [x, , z] = placed.position;
      return clearanceTo(shelterColliders('decor:p', placed))([x, 0.14, z]);
    };
    const at = item('rock-pile-cave', 0, 0);
    expect(probe(at)).toBeLessThan(0);
    expect(probe(item('rock-pile-cave', 0, 0, { rotationY: 1 }))).toBeLessThan(0);
    const moved = item('rock-pile-cave', 0.5, 0);
    expect(clearanceTo(shelterColliders('decor:p', moved))([0, 0.14, 0])).toBeGreaterThan(0.1);
  });
});

describe.each(SHELTERS)('%s against its own mesh', (id) => {
  describe.each(PLACEMENTS)('placed %o', (extra) => {
    const placed = item(id, 0.3, -0.1, extra);

    it('is as solid as the mesh: every vertex is inside a part', async () => {
      const clearance = clearanceTo(collidersFor('p', spec(id), placed));
      const v = new Vector3();
      const matrix = decorMatrix(placed);
      let worst = -Infinity;
      for (const geometry of await library.collisionGeometry(id)) {
        const position = geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
          v.fromBufferAttribute(position, i).applyMatrix4(matrix);
          worst = Math.max(worst, clearance([v.x, v.y, v.z]));
        }
      }
      expect(worst).toBeLessThanOrEqual(MESH_TOLERANCE_M * placed.scale);
    });

    it('is no looser than the single hull the scene fits', async () => {
      const whole = sceneCollidersToSim(
        fitCollider(catalog.get(id).kind, await library.collisionGeometry(id), placed),
      );
      const outside = clearanceTo(whole);
      for (const c of collidersFor('p', spec(id), placed)) {
        if (c.kind !== 'hull') throw new Error('expected hulls');
        for (const vertex of c.vertices) {
          expect(outside(vertex)).toBeLessThanOrEqual(MESH_TOLERANCE_M * placed.scale);
        }
      }
    });
  });
});

describe('the shelter meshes the parts were cut from', () => {
  it.each(SHELTERS)('%s: the LOD2 file is unchanged', async (id) => {
    const file = catalog.get(id).lods[2]?.file;
    if (!file) throw new Error(`${id} has no LOD2`);
    const bytes = await readFile(join(PUBLIC, 'assets', file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(LOD2_SHA256[id]);
  });

  it('a shelter placed on a slope is refused rather than given an upright collider', () => {
    expect(() =>
      collidersFor('p', spec('reef-arch'), item('reef-arch', 0, 0), [0.3, 0.9, 0]),
    ).toThrow(/upright/);
  });
});

describe('the cave mouth is reachable', () => {
  it.each(SHELTERS)(
    '%s: a fish at the pulled-in mouth is clear of the parts at every rotation and scale',
    (id) => {
      for (const scale of SWEEP_SCALES) {
        for (const rotationY of SWEEP_ROTATIONS) {
          const placed = item(id, 0.3, -0.1, { rotationY, scale });
          const mouth = mouthAt(id, placed, PULLED_IN_Z[id]);
          const clearance = clearanceTo(collidersFor('p', spec(id), placed));
          expect(
            clearance(mouth.position.toArray()),
            `rotation ${rotationY.toFixed(2)}, scale ${scale}`,
          ).toBeGreaterThanOrEqual(FISH_CLEARANCE * mouth.radius);
        }
      }
    },
  );

  it.each(SHELTERS)('%s: the way in along its facing never touches a part', (id) => {
    for (const rotationY of SWEEP_ROTATIONS.filter((_, i) => i % 5 === 0)) {
      const placed = item(id, 0.3, -0.1, { rotationY, scale: 1.3 });
      const mouth = mouthAt(id, placed, PULLED_IN_Z[id]);
      const clearance = clearanceTo(collidersFor('p', spec(id), placed));
      for (let d = 0; d <= 0.3; d += 0.005) {
        const p = mouth.position.clone().addScaledVector(mouth.facing, d);
        expect(
          clearance(p.toArray()),
          `rotation ${rotationY.toFixed(2)}, ${d} m out`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it.each(['reef-arch', 'rock-pile-cave', 'rock-pile-stack'] as const)(
    '%s: the same mouth was out of reach behind the old footprint box',
    (id) => {
      const placed = item(id, 0.3, -0.1);
      const mouth = mouthAt(id, placed, PULLED_IN_Z[id]);
      expect(clearanceTo(boxFor(id, placed))(mouth.position.toArray())).toBeLessThan(
        FISH_CLEARANCE * mouth.radius,
      );
    },
  );

  it('the arch passes a fish clean through, not just to its front', () => {
    const placed = item('reef-arch', 0, 0);
    const clearance = clearanceTo(collidersFor('p', spec('reef-arch'), placed));
    for (let z = -0.1; z <= 0.1; z += 0.005) {
      expect(clearance([0.005, 0.06 + 0.03, z]), `z ${z}`).toBeGreaterThanOrEqual(0.7 * 0.025);
    }
  });
});

describe('a cave opening inside a neighbouring placed rock', () => {
  const placedCave = (extra: Partial<DecorItem> = {}) => item('reef-arch', 0, 0, extra);
  const anchors = (placed: DecorItem) => [caveAnchor('cave-1', placed)];

  function colliders(items: readonly DecorItem[]): Collider[] {
    const specs = specsFromCatalog(catalog.entries());
    return items.flatMap((it, i) => collidersFor(`p${i}`, must(specs.get(it.assetId)), it));
  }

  it('is reported as blocked when a rock sits on the mouth', () => {
    const cave = placedCave();
    const [anchor] = anchors(cave);
    const [x, , z] = must(anchor).position;
    const rock = item('boulder-01', x, z);
    expect(blockedMouths(anchors(cave), colliders([cave, rock]))).toEqual(['cave-1']);
  });

  it('is not reported while the neighbour stands clear of the opening', () => {
    const cave = placedCave();
    const rock = item('boulder-01', 0.6, 0.2);
    expect(blockedMouths(anchors(cave), colliders([cave, rock]))).toEqual([]);
  });

  it('does not count the cave itself, which leaves the mouth clear', () => {
    const cave = placedCave({ rotationY: 0.8 });
    expect(blockedMouths(anchors(cave), colliders([cave]))).toEqual([]);
  });

  it('is clear again once the rock is moved away', () => {
    const cave = placedCave();
    const [anchor] = anchors(cave);
    const [x, , z] = must(anchor).position;
    expect(blockedMouths(anchors(cave), colliders([cave, item('boulder-01', x, z)]))).toHaveLength(
      1,
    );
    expect(blockedMouths(anchors(cave), colliders([cave, item('boulder-01', x + 0.5, z)]))).toEqual(
      [],
    );
  });

  describe('near the blocking threshold', () => {
    const rock = item('boulder-01', 0, 0);
    const mouthAtClearance = (share: number) => {
      const surfaceClearance = clearanceTo(colliders([rock]));
      const radius = 0.04;
      const probe: [number, number, number] = [0, 0.4, 0];
      let y = 0.4;
      while (surfaceClearance([0, y, 0]) > share * radius) y -= 0.0005;
      probe[1] = y;
      return { id: 'm', position: probe, radius };
    };

    it('reports a mouth just inside half its radius from the rock', () => {
      expect(blockedMouths([mouthAtClearance(0.48)], colliders([rock]))).toEqual(['m']);
    });

    it('keeps a mouth just outside half its radius', () => {
      expect(blockedMouths([mouthAtClearance(0.55)], colliders([rock]))).toEqual([]);
    });
  });

  it('ignores a soft collider on the mouth', () => {
    const soft: Collider = {
      id: 'plant:1',
      hard: false,
      kind: 'capsule',
      a: [0, 0.05, 0],
      b: [0, 0.2, 0],
      radius: 0.08,
    };
    const mouth = { id: 'm', position: [0, 0.1, 0] as const, radius: 0.03 };
    expect(blockedMouths([mouth], [soft])).toEqual([]);
  });
});
