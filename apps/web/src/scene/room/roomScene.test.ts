import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOM_IDS, roomFileSchema, TANK_SIZES, type RoomId } from '@aquarium/shared';
import { STAND_HEIGHT, TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import { TIERS, type Tier } from '../../engine/quality/tiers';
import { windowSlotFor, type Bounds } from './layout';
import {
  COMMUNITY_ROOM_ID,
  planRoomChoice,
  planRoomScene,
  propCatalogFrom,
  ROOM_HDRI_YAW,
  ROOM_PRESET_DATA,
  ROOM_TIER_POLICY,
  roomPresetData,
} from './roomScene';

const ASSETS = join(__dirname, '../../../public/assets');
const index = JSON.parse(readFileSync(join(ASSETS, 'index.json'), 'utf8')) as {
  assets: Parameters<typeof propCatalogFrom>[0] extends Iterable<infer E> ? E[] : never;
};
const catalog = propCatalogFrom(index.assets);
const rooms = roomFileSchema.parse(
  JSON.parse(readFileSync(join(__dirname, '../../../../../content/rooms.json'), 'utf8')),
);
const sizes = Object.keys(TANK_SIZES) as (keyof typeof TANK_SIZES)[];
const EPS = 1e-6;
const SHELL_DRAWS = 5;

function primitives(file: string): number {
  const bytes = readFileSync(join(ASSETS, file));
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as {
    meshes: { primitives: unknown[] }[];
  };
  return json.meshes.reduce((sum, m) => sum + m.primitives.length, 0);
}

function drawCalls(plan: ReturnType<typeof planRoomScene>): number {
  const assets = new Map(plan.props.map((p) => [p.asset, p.lod]));
  let calls = 0;
  for (const [asset, lod] of assets) {
    const file = index.assets.find((a) => a.id === asset)?.lods[lod] as unknown as { file: string };
    calls += primitives(file.file);
  }
  return calls;
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return ([0, 1, 2] as const).every((i) => a.min[i] < b.max[i] - EPS && b.min[i] < a.max[i] - EPS);
}

describe('room presets', () => {
  it('has a layout and a window decision for each of the 12 rooms', () => {
    expect(ROOM_IDS).toHaveLength(12);
    for (const room of rooms) {
      const preset = ROOM_PRESET_DATA[room.id];
      expect(preset.layout.length, room.id).toBeGreaterThan(0);
      expect(preset.light.windowPosition !== null, room.id).toBe(room.hasWindow);
    }
  });

  it('only places props the room lists as its furniture', () => {
    for (const room of rooms) {
      for (const prop of ROOM_PRESET_DATA[room.id].layout) {
        expect(room.assets.furniture, `${room.id} ${prop.asset}`).toContain(prop.asset);
      }
    }
  });

  it('uses every furniture entry of the room', () => {
    for (const room of rooms) {
      const used = new Set(ROOM_PRESET_DATA[room.id].layout.map((p) => p.asset));
      for (const id of room.assets.furniture) expect(used.has(id), `${room.id} ${id}`).toBe(true);
    }
  });

  it('rejects an unknown room id', () => {
    expect(() => roomPresetData('room-nope')).toThrow(/Unknown room "room-nope"/);
    expect(() =>
      planRoomChoice('room-nope', { tank: TANK_DIMENSIONS.standard, tier: 'high', catalog }),
    ).toThrow(RangeError);
  });

  it('plans nothing for the "no room" setting', () => {
    expect(
      planRoomChoice(null, { tank: TANK_DIMENSIONS.standard, tier: 'high', catalog }),
    ).toBeNull();
  });

  it('puts the community tank in the public aquarium hall', () => {
    expect(COMMUNITY_ROOM_ID).toBe('room-public-aquarium');
  });

  it('turns the uShaka environment so the lit sign leaves the default view', () => {
    const yaw = planRoomScene({
      roomId: 'room-public-aquarium',
      tank: TANK_DIMENSIONS.standard,
      tier: 'low',
      catalog,
    }).hdriYaw;
    expect(yaw).toBe(ROOM_HDRI_YAW['room-public-aquarium']);
    expect(yaw).not.toBe(0);
    expect(
      planRoomScene({ roomId: 'room-living', tank: TANK_DIMENSIONS.standard, tier: 'low', catalog })
        .hdriYaw,
    ).toBe(0);
  });
});

describe.each(ROOM_IDS)('%s', (roomId: RoomId) => {
  const hasWindow = rooms.find((r) => r.id === roomId)?.hasWindow ?? false;

  describe.each(sizes)('around the %s tank', (size) => {
    const tank = TANK_DIMENSIONS[size];
    const plan = planRoomScene({ roomId, tank, tier: 'ultra', catalog });
    const stand: Bounds = {
      min: [-tank.length / 2, -STAND_HEIGHT, -tank.depth / 2],
      max: [tank.length / 2, 0, tank.depth / 2],
    };
    const tankBox: Bounds = {
      min: [-tank.length / 2, 0, -tank.depth / 2],
      max: [tank.length / 2, tank.height, tank.depth / 2],
    };

    it('keeps every prop inside the room', () => {
      for (const prop of plan.props) {
        for (const i of [0, 1, 2] as const) {
          expect(prop.bounds.min[i], `${prop.asset} min ${i}`).toBeGreaterThanOrEqual(
            plan.shell.min[i] - EPS,
          );
          expect(prop.bounds.max[i], `${prop.asset} max ${i}`).toBeLessThanOrEqual(
            plan.shell.max[i] + EPS,
          );
        }
      }
    });

    it('never puts a prop through the tank or its stand', () => {
      for (const prop of plan.props) {
        expect(overlaps(prop.bounds, stand), `${prop.asset} / stand`).toBe(false);
        expect(overlaps(prop.bounds, tankBox), `${prop.asset} / tank`).toBe(false);
      }
    });

    it('stands floor props apart', () => {
      const floor = plan.props.filter((p) => Math.abs(p.position[1] + STAND_HEIGHT) < 1e-3);
      floor.forEach((a, i) => {
        for (const b of floor.slice(i + 1)) {
          expect(overlaps(a.bounds, b.bounds), `${a.asset} / ${b.asset}`).toBe(false);
        }
      });
    });

    it('rests raised props on a host or hangs them from a wall or the ceiling', () => {
      const ceiling = plan.shell.max[1];
      for (const prop of plan.props) {
        expect(prop.bounds.max[1], prop.asset).toBeLessThanOrEqual(ceiling + EPS);
      }
    });

    it(hasWindow ? 'has a window to the right of the tank' : 'has no window', () => {
      if (!plan.window) {
        expect(hasWindow).toBe(false);
        return;
      }
      expect(plan.window.centre[0] - plan.window.size[0] / 2).toBeGreaterThan(tank.length / 2);
      expect(plan.window.centre[2]).toBe(plan.shell.min[2]);
    });

    it('keeps the window clear of tall props', () => {
      if (!plan.window) return;
      const { centre, size } = plan.window;
      const opening: Bounds = {
        min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2, plan.shell.min[2]],
        max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2, plan.shell.min[2] + 1.5],
      };
      for (const prop of plan.props) {
        expect(overlaps(prop.bounds, opening), `${prop.asset} in front of the window`).toBe(false);
      }
    });
  });
});

describe('the window follows the tank', () => {
  const tune = ROOM_PRESET_DATA['room-living'];

  it('moves with the tank length and keeps the room tuned height', () => {
    const wide = planRoomScene({
      roomId: 'room-living',
      tank: TANK_DIMENSIONS.long300,
      tier: 'high',
      catalog,
    });
    const narrow = planRoomScene({
      roomId: 'room-living',
      tank: TANK_DIMENSIONS.nano30,
      tier: 'high',
      catalog,
    });
    const dx = (TANK_DIMENSIONS.long300.length - TANK_DIMENSIONS.nano30.length) / 2;
    expect((wide.window?.centre[0] ?? 0) - (narrow.window?.centre[0] ?? 0)).toBeCloseTo(dx, 9);
    expect(wide.window?.centre[1]).toBe(tune.light.windowPosition?.[1]);
    expect(narrow.window?.centre[1]).toBe(tune.light.windowPosition?.[1]);
  });

  it('matches the slot the backdrop builds for the same tank', () => {
    const tank = TANK_DIMENSIONS.std200;
    const plan = planRoomScene({ roomId: 'room-living', tank, tier: 'high', catalog });
    expect(plan.window).toEqual(windowSlotFor(tank, tune.light.windowPosition?.[1]));
  });

  it('is tuned per room, not fixed at the seed position', () => {
    const heights = new Set(
      ROOM_IDS.flatMap((id) => {
        const p = ROOM_PRESET_DATA[id].light.windowPosition;
        return p ? [p[1]] : [];
      }),
    );
    expect(heights.size).toBeGreaterThan(3);
  });

  it('stays at the wall when the tank grows deeper', () => {
    const tank = { ...TANK_DIMENSIONS.standard, depth: 0.8 };
    const plan = planRoomScene({ roomId: 'room-living', tank, tier: 'high', catalog });
    expect(plan.window?.centre[2]).toBeCloseTo(-(0.4 + 0.12), 9);
  });
});

describe('props placed around a changing tank', () => {
  it('moves flanking props with the side wall', () => {
    const at = (tank: typeof TANK_DIMENSIONS.standard) =>
      planRoomScene({ roomId: 'room-living', tank, tier: 'high', catalog }).props[0];
    const standard = at(TANK_DIMENSIONS.standard);
    const long = at(TANK_DIMENSIONS.long300);
    expect(long?.position[0]).toBeLessThan(standard?.position[0] ?? 0);
  });

  it('rejects a tank with no size', () => {
    expect(() =>
      planRoomScene({
        roomId: 'room-living',
        tank: { length: 0, depth: 1, height: 1 },
        tier: 'high',
        catalog,
      }),
    ).toThrow(RangeError);
  });

  it('fails loudly on a prop the asset index lacks', () => {
    expect(() =>
      planRoomScene({
        roomId: 'room-living',
        tank: TANK_DIMENSIONS.standard,
        tier: 'high',
        catalog: () => undefined,
      }),
    ).toThrow(/run pnpm build:assets/);
  });
});

describe('hanging props', () => {
  it('hangs the loft lamp from the ceiling using its bounds', () => {
    const plan = planRoomScene({
      roomId: 'room-loft',
      tank: TANK_DIMENSIONS.standard,
      tier: 'ultra',
      catalog,
    });
    const lamp = plan.props.find((p) => p.asset === 'polyhaven-hanging-industrial-lamp');
    expect(lamp).toBeDefined();
    expect(lamp?.bounds.max[1]).toBeCloseTo(plan.shell.max[1], 2);
  });
});

describe('quality tiers', () => {
  it('leaves the low tier to the shell and the HDRI', () => {
    for (const roomId of ROOM_IDS) {
      const plan = planRoomScene({ roomId, tank: TANK_DIMENSIONS.standard, tier: 'low', catalog });
      expect(plan.props, roomId).toHaveLength(0);
      expect(plan.light.practical, roomId).toHaveLength(0);
    }
  });

  it.each(sizes)('keeps the mobile tier inside 15k triangles and 10 draw calls (%s)', (size) => {
    for (const room of rooms) {
      const plan = planRoomScene({
        roomId: room.id,
        tank: TANK_DIMENSIONS[size],
        tier: 'medium',
        catalog,
      });
      const triangles = plan.props.reduce((s, p) => s + p.triangles, 0);
      expect(triangles, room.id).toBeLessThanOrEqual(15_000);
      expect(triangles).toBe(plan.triangles);
      const draws = drawCalls(plan) + SHELL_DRAWS;
      expect(draws, room.id).toBeLessThanOrEqual(10);
    }
  });

  it.each(sizes)('keeps the high tier inside 60k triangles and 30 draw calls (%s)', (size) => {
    for (const tier of ['high', 'ultra'] as Tier[]) {
      for (const room of rooms) {
        const plan = planRoomScene({ roomId: room.id, tank: TANK_DIMENSIONS[size], tier, catalog });
        expect(plan.triangles, room.id).toBeLessThanOrEqual(60_000);
        expect(drawCalls(plan) + SHELL_DRAWS + 1, room.id).toBeLessThanOrEqual(30);
      }
    }
  });

  it('shows every authored prop on mobile where the budget allows', () => {
    for (const room of rooms) {
      const plan = planRoomScene({
        roomId: room.id,
        tank: TANK_DIMENSIONS.standard,
        tier: 'medium',
        catalog,
      });
      expect(plan.dropped, room.id).toEqual([]);
      expect(plan.props).toHaveLength(ROOM_PRESET_DATA[room.id].layout.length);
    }
  });

  it('drops the last props, keeping the hosts, when a tier is over budget', () => {
    const tight = planRoomScene({
      roomId: 'room-sushi',
      tank: TANK_DIMENSIONS.standard,
      tier: 'medium',
      catalog: (id) => {
        const entry = catalog(id);
        return entry && { ...entry, lods: entry.lods.map((l) => ({ triangles: l.triangles * 5 })) };
      },
    });
    expect(tight.dropped.length).toBeGreaterThan(0);
    expect(tight.props[0]?.asset).toBe('polyhaven-round-wooden-table-02');
    expect(tight.props.map((p) => p.asset)).not.toContain(tight.dropped[0]);
    expect(tight.triangles).toBeLessThanOrEqual(ROOM_TIER_POLICY.medium.maxTriangles);
  });

  it('counts every placement of an instanced prop in the triangles but draws it once', () => {
    const plan = planRoomScene({
      roomId: 'room-sushi',
      tank: TANK_DIMENSIONS.standard,
      tier: 'medium',
      catalog,
    });
    const chairs = plan.props.filter((p) => p.asset === 'polyhaven-bar-chair-round-01');
    expect(chairs.length).toBeGreaterThan(1);
    expect(plan.triangles).toBeGreaterThanOrEqual(chairs.reduce((s, c) => s + c.triangles, 0));
    expect(drawCalls(plan)).toBeLessThan(plan.props.length);
  });

  it('uses the mobile LOD below high and the full one above', () => {
    const lod = (tier: Tier) =>
      planRoomScene({ roomId: 'room-living', tank: TANK_DIMENSIONS.standard, tier, catalog })
        .props[0]?.lod;
    expect(lod('medium')).toBe(2);
    expect(lod('high')).toBe(0);
    expect(TIERS).toContain('ultra');
  });
});

describe('light rig', () => {
  const plan = (roomId: RoomId, tier: Tier = 'ultra') =>
    planRoomScene({ roomId, tank: TANK_DIMENSIONS.standard, tier, catalog });

  it('adds real lights for the lamps and the stove, not for plain furniture', () => {
    expect(
      plan('room-cabin')
        .light.practical.map((l) => l.asset)
        .sort(),
    ).toEqual(['polyhaven-scandinavian-masonry-heater', 'polyhaven-vintage-oil-lamp']);
    expect(plan('room-loft').light.practical.map((l) => l.asset)).toEqual([
      'polyhaven-hanging-industrial-lamp',
    ]);
    expect(plan('room-living').light.practical).toHaveLength(0);
  });

  it('keeps lamp lights finite so they cannot wash the tank', () => {
    for (const id of ROOM_IDS) {
      for (const lamp of plan(id).light.practical) {
        expect(lamp.distance).toBeGreaterThan(0);
        expect(lamp.distance).toBeLessThanOrEqual(3);
      }
    }
  });

  it('places each lamp light at its prop', () => {
    const lamp = plan('room-cabin').light.practical.find((l) => l.asset.endsWith('oil-lamp'));
    const prop = plan('room-cabin').props.find((p) => p.asset.endsWith('oil-lamp'));
    expect(lamp?.position[0]).toBeCloseTo(prop?.position[0] ?? NaN, 6);
    expect(lamp?.position[1]).toBeGreaterThan(prop?.position[1] ?? NaN);
  });

  it('turns lamp lights off below the high tier', () => {
    expect(plan('room-cabin', 'medium').light.practical).toHaveLength(0);
  });

  it('takes the key from the window, or from above the tank without one', () => {
    const withWindow = plan('room-living');
    expect(withWindow.light.key.position[0]).toBe(withWindow.window?.centre[0]);
    const without = plan('room-shop');
    expect(without.window).toBeNull();
    expect(without.light.key.position[0]).toBe(0);
  });
});
