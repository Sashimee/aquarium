import { describe, expect, it } from 'vitest';
import { CameraRig, orbitDistanceFor, tankBounds, type CameraLike, type Vec3 } from './camera';
import { framingScale, TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { planRoom } from '../scene/room/layout';

type Size = keyof typeof TANK_DIMENSIONS;
type Preset = 'living-room' | 'office';

const sizes = Object.keys(TANK_DIMENSIONS) as Size[];
const presets: Preset[] = ['living-room', 'office'];
const rates = [30, 60, 144, 240];
const SETTLE_SECONDS = 8;
const HOLD_SECONDS = 0.5;

function fakeCamera() {
  const camera = {
    pos: { x: 0, y: 0, z: 0 } as Vec3,
    position: {
      set(x: number, y: number, z: number) {
        camera.pos = { x, y, z };
      },
    },
    lookAt() {},
  };
  return camera satisfies CameraLike & { pos: Vec3 };
}

function roomRig(size: Size, preset: Preset) {
  const d = TANK_DIMENSIONS[size];
  const { shell } = planRoom(preset, d);
  const room = {
    min: { x: shell.min[0], y: shell.min[1], z: shell.min[2] },
    max: { x: shell.max[0], y: shell.max[1], z: shell.max[2] },
  };
  const cam = fakeCamera();
  const rig = new CameraRig(cam, tankBounds(d), {
    orbitDistance: orbitDistanceFor(framingScale(d)),
  });
  rig.setRoom(room);
  return { rig, cam, room, d };
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

type Step =
  | { drag: [number, number]; zoom?: number | undefined; frames: number }
  | { orbit: [number, number, number]; frames: number };

function run(rig: CameraRig, cam: { pos: Vec3 }, hz: number, steps: Step[], label: string) {
  const d = (n: number) => Math.round(n);
  for (const [i, step] of steps.entries()) {
    if ('drag' in step) {
      rig.drag(step.drag[0], step.drag[1]);
      if (step.zoom !== undefined) rig.zoom(step.zoom);
    } else {
      rig.setOrbit(...step.orbit);
    }
    for (let f = 0; f < d(step.frames); f++) {
      rig.update(1 / hz);
      expect(Number.isFinite(cam.pos.x + cam.pos.y + cam.pos.z), `${label} step ${i}`).toBe(true);
    }
  }
}

function expectRestsOnGoal(rig: CameraRig, cam: { pos: Vec3 }, hz: number, label: string) {
  let frames = 0;
  while (frames < SETTLE_SECONDS * hz && gap(cam.pos, rig.goalPosition) >= 1e-3) {
    rig.update(1 / hz);
    frames++;
  }
  const arrived = `${label} after ${frames / hz} s`;
  expect(gap(cam.pos, rig.goalPosition), arrived).toBeLessThan(1e-3);
  for (let held = 0; held < HOLD_SECONDS * hz; held++) {
    rig.update(1 / hz);
    expect(gap(cam.pos, rig.goalPosition), `${arrived}, held ${held / hz} s`).toBeLessThan(1e-3);
  }
}

describe('camera in a room: the eye always rests on its goal', () => {
  it('replays the reviewer drag sequence that wedged the eye behind the tank', () => {
    const { rig, cam } = roomRig('nano30', 'living-room');
    for (let t = 0; t < 5; t += 1 / 144) rig.update(1 / 144);
    run(
      rig,
      cam,
      144,
      [
        { drag: [608, -147], frames: 153 },
        { drag: [1483, -294], zoom: 2.2, frames: 157 },
        { drag: [180, -13], zoom: 1.68, frames: 115 },
        { drag: [309, 49], frames: 176 },
        { drag: [821, -72], frames: 9 },
        { drag: [855, -89], zoom: 1.3, frames: 169 },
      ],
      'replay',
    );
    expectRestsOnGoal(rig, cam, 144, 'replay');
    rig.setOrbit(0, 0.1, 1);
    expectRestsOnGoal(rig, cam, 144, 'replay setOrbit');
    expect(cam.pos.z).toBeGreaterThan(0);
  });

  it('settles on its goal after 400 seeded random drag, zoom and setOrbit sequences', () => {
    const rand = seeded(20261021);
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(rand() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    };
    for (let n = 0; n < 400; n++) {
      const size = pick(sizes);
      const preset = pick(presets);
      const hz = pick(rates);
      const { rig, cam, room, d } = roomRig(size, preset);
      for (let t = 0; t < 1; t += 1 / hz) rig.update(1 / hz);
      const steps: Step[] = [];
      for (let i = 0; i < 6; i++) {
        const frames = Math.round(between(0, 1.5 * hz));
        steps.push(
          rand() < 0.25
            ? {
                orbit: [between(-Math.PI, Math.PI), between(-0.15, 1.35), between(0.01, 3)],
                frames,
              }
            : {
                drag: [between(-1500, 1500), between(-300, 300)],
                zoom: rand() < 0.4 ? between(0.6, 2.3) : undefined,
                frames,
              },
        );
      }
      const label = `#${n} ${size} ${preset} ${hz} Hz`;
      run(rig, cam, hz, steps, label);
      expectRestsOnGoal(rig, cam, hz, label);
      expect(cam.pos.x).toBeGreaterThan(room.min.x);
      expect(cam.pos.x).toBeLessThan(room.max.x);
      expect(cam.pos.z).toBeGreaterThan(room.min.z);
      expect(cam.pos.z).toBeLessThan(room.max.z);
      expect(
        Math.abs(cam.pos.x) >= d.length / 2 ||
          Math.abs(cam.pos.z) >= d.depth / 2 ||
          cam.pos.y >= d.height,
        label,
      ).toBe(true);

      const orbit: [number, number, number] = [
        between(-Math.PI, Math.PI),
        between(-0.15, 1.35),
        between(0.01, 3),
      ];
      rig.setOrbit(...orbit);
      expectRestsOnGoal(rig, cam, hz, `${label} setOrbit`);
    }
  }, 20_000);
});
