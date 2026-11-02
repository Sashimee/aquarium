import { describe, expect, it } from 'vitest';
import { CameraRig, orbitDistanceFor, tankBounds, type CameraLike, type Vec3 } from './camera';
import { framingScale, TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { planRoom } from '../scene/room/layout';

type Size = keyof typeof TANK_DIMENSIONS;
type Preset = 'living-room' | 'office';

const sizes = Object.keys(TANK_DIMENSIONS) as Size[];
const presets: Preset[] = ['living-room', 'office'];
const rates = [30, 60, 144, 240];
const CLEARANCE_SLACK = 0.13;

function build(size: Size, preset: Preset) {
  const d = TANK_DIMENSIONS[size];
  const { shell } = planRoom(preset, d);
  const room = {
    min: { x: shell.min[0], y: shell.min[1], z: shell.min[2] },
    max: { x: shell.max[0], y: shell.max[1], z: shell.max[2] },
  };
  const make = () => {
    const camera = {
      pos: { x: 0, y: 0, z: 0 } as Vec3,
      position: {
        set(x: number, y: number, z: number) {
          camera.pos = { x, y, z };
        },
      },
      lookAt() {},
    };
    const rig = new CameraRig(camera satisfies CameraLike, tankBounds(d), {
      orbitDistance: orbitDistanceFor(framingScale(d)),
    });
    rig.setRoom(room);
    return { rig, camera };
  };
  return { d, room, live: make(), reference: make() };
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gap = (a: Vec3, b: Readonly<Vec3>) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Every input goes to a second rig that is never updated. Its goal is the pose the player asked for
 * at input time, so a live rig that quietly changes its own goal cannot hide behind it.
 */
function watch(size: Size, preset: Preset, hz: number, label: string) {
  const { d, room, live, reference } = build(size, preset);
  const centre = { x: 0, y: d.height / 2, z: 0 };
  const alphaMax = 1 - Math.exp(-14 / hz);
  const frame = (ctx: string) => {
    const before = { ...live.camera.pos };
    live.rig.update(1 / hz);
    const eye = live.camera.pos;
    const goal = reference.rig.goalPosition;
    const wasOutside =
      Math.abs(before.x) >= d.length / 2 ||
      Math.abs(before.z) >= d.depth / 2 ||
      before.y >= d.height;
    if (wasOutside && live.rig.mode === 'orbit') {
      const r0 = gap(before, centre);
      const bound =
        alphaMax * (Math.PI * r0 + Math.abs(gap(goal, centre) - r0) + Math.abs(goal.y - before.y));
      expect(gap(eye, before), `${label} ${ctx} step`).toBeLessThanOrEqual(bound + CLEARANCE_SLACK);
      expect(
        Math.abs(eye.x) >= d.length / 2 - 1e-9 ||
          Math.abs(eye.z) >= d.depth / 2 - 1e-9 ||
          eye.y >= d.height - 1e-9,
        `${label} ${ctx} outside glass`,
      ).toBe(true);
    }
    expect(eye.x, `${label} ${ctx}`).toBeGreaterThan(room.min.x);
    expect(eye.x, `${label} ${ctx}`).toBeLessThan(room.max.x);
    expect(eye.z, `${label} ${ctx}`).toBeGreaterThan(room.min.z);
    expect(eye.z, `${label} ${ctx}`).toBeLessThan(room.max.z);
  };
  const both = (apply: (rig: CameraRig) => void) => {
    apply(live.rig);
    apply(reference.rig);
  };
  const run = (seconds: number, ctx: string) => {
    for (let f = 0; f < Math.round(seconds * hz); f++) frame(`${ctx} f${f}`);
  };
  const rest = (ctx: string) => {
    run(12, ctx);
    expect(
      gap(live.camera.pos, reference.rig.goalPosition),
      `${label} ${ctx} rests on the request`,
    ).toBeLessThan(1e-3);
  };
  return { live, reference, both, run, rest };
}

describe('camera in a room: the path follows what was asked', () => {
  it('leaves focus near the back glass the short way round and lands on the requested pose', () => {
    for (const hz of rates) {
      const w = watch('long300', 'living-room', hz, `long300 living ${hz}`);
      w.run(5, 'settle');
      const fish = { x: 0.45, y: 0.135, z: -0.195 };
      w.both((rig) => rig.focusOn(() => fish));
      w.run(4, 'focus');
      w.both((rig) => rig.drag(300, 0));
      w.run(1, 'drag');
      w.both((rig) => rig.exit());
      const start = { ...w.live.camera.pos };
      const yawOf = (p: Vec3) => Math.atan2(p.x, p.z);
      let travelled = 0;
      let last = yawOf(start);
      for (let f = 0; f < 6 * hz; f++) {
        w.run(1 / hz, `exit f${f}`);
        const now = yawOf(w.live.camera.pos);
        travelled += Math.abs(Math.atan2(Math.sin(now - last), Math.cos(now - last)));
        last = now;
      }
      const goalYaw = yawOf(w.reference.rig.goalPosition);
      const shortest = Math.abs(
        Math.atan2(Math.sin(goalYaw - yawOf(start)), Math.cos(goalYaw - yawOf(start))),
      );
      expect(travelled, `hz ${hz}`).toBeLessThan(shortest + 0.35);
      w.rest('exit');
    }
  });

  it('reaches the goal of two consecutive setOrbit requests', () => {
    for (const hz of rates) {
      const w = watch('std200', 'office', hz, `std200 office ${hz}`);
      w.run(5, 'settle');
      w.both((rig) => rig.setOrbit(1.87, -0.143, 2.667));
      w.run(0.4, 'first');
      w.both((rig) => rig.setOrbit(-1.643, 0.009, 2.211));
      w.rest('second');
    }
  });

  it('rests on the requested pose after 150 seeded input sequences, with bounded steps', () => {
    const rand = seeded(20261023);
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(rand() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    };
    for (let n = 0; n < 150; n++) {
      const size = pick(sizes);
      const preset = pick(presets);
      const hz = pick(rates);
      const label = `#${n} ${size} ${preset} ${hz} Hz`;
      const w = watch(size, preset, hz, label);
      w.run(5, 'settle');
      for (let i = 0; i < 6; i++) {
        const roll = rand();
        if (roll < 0.3) {
          const o: [number, number, number] = [
            between(-Math.PI, Math.PI),
            between(-0.15, 1.35),
            between(0.01, 3),
          ];
          w.both((rig) => rig.setOrbit(...o));
        } else if (roll < 0.4) {
          const at = { x: between(-0.4, 0.4), y: between(0.1, 0.4), z: between(-0.2, 0.2) };
          w.both((rig) => rig.focusOn(() => at));
        } else if (roll < 0.5) {
          w.both((rig) => rig.exit());
        } else {
          const dx = between(-1500, 1500);
          const dy = between(-300, 300);
          w.both((rig) => rig.drag(dx, dy));
        }
        w.run(between(0, 1.5), `step ${i}`);
      }
      w.both((rig) => rig.exit());
      w.rest('end');
    }
  }, 60_000);
});
