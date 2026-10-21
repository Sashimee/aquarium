import { describe, expect, it, vi } from 'vitest';
import { TANK_DIMENSIONS, framingScale } from '../engine/tank/dimensions';
import { planRoom } from '../scene/room/layout';
import { CameraRig, orbitDistanceFor, tankBounds, type CameraMode } from './camera';
import {
  IDLE_AFTER_SECONDS,
  IDLE_YAW_RATE,
  IdleOrbit,
  type Orbitable,
  bindIdleInput,
} from './idleOrbit';
import { roomVolume } from './roomLimit';

describe('IdleOrbit on the real rig', () => {
  const sizes = Object.keys(TANK_DIMENSIONS) as (keyof typeof TANK_DIMENSIONS)[];
  const FRAME = 1 / 30;
  const NORMAL_STEP = IDLE_YAW_RATE * FRAME;

  for (const size of sizes) {
    for (const preset of ['living-room', 'office'] as const) {
      it(`sweeps smoothly inside the ${preset} around a ${size} tank`, () => {
        const d = TANK_DIMENSIONS[size];
        const { shell } = planRoom(preset, d);
        const camera = {
          pos: { x: 0, y: 0, z: 0 },
          position: {
            set(x: number, y: number, z: number) {
              camera.pos = { x, y, z };
            },
          },
          lookAt() {},
        };
        const b = tankBounds(d);
        const rig = new CameraRig(camera, b, { orbitDistance: orbitDistanceFor(framingScale(d)) });
        rig.setRoom(roomVolume({ shell }));
        const idle = new IdleOrbit(rig);
        for (let t = 0; t < IDLE_AFTER_SECONDS; t += FRAME) idle.update(FRAME);
        for (let i = 0; i < 20; i++) rig.update(FRAME);

        const startPitch = rig.orbitAngles.pitch;
        const startDistance = rig.orbitDistance;
        const startYaw = rig.orbitAngles.yaw;
        let yaw = startYaw;
        let travelled = 0;
        let worstStep = 0;
        let minYaw = yaw;
        let maxYaw = yaw;
        for (let t = 0; t < 300; t += FRAME) {
          idle.update(FRAME);
          rig.update(FRAME);
          const next = rig.orbitAngles;
          const step = Math.abs(next.yaw - yaw);
          worstStep = Math.max(worstStep, step);
          travelled += step;
          yaw = next.yaw;
          minYaw = Math.min(minYaw, yaw);
          maxYaw = Math.max(maxYaw, yaw);
          expect(next.pitch).toBeCloseTo(startPitch, 6);
          const { x, y, z } = camera.pos;
          expect(x).toBeGreaterThanOrEqual(shell.min[0]);
          expect(x).toBeLessThanOrEqual(shell.max[0]);
          expect(y).toBeGreaterThanOrEqual(shell.min[1]);
          expect(y).toBeLessThanOrEqual(shell.max[1]);
          expect(z).toBeGreaterThanOrEqual(shell.min[2]);
          expect(z).toBeLessThanOrEqual(shell.max[2]);
          const insideGlass =
            Math.abs(x) < b.halfLength &&
            Math.abs(z) < b.halfDepth &&
            y > b.floor &&
            y < b.waterTop;
          expect(insideGlass).toBe(false);
        }
        while (Math.abs(rig.orbitAngles.yaw - startYaw) > 1e-9) {
          const gap = rig.orbitAngles.yaw - startYaw;
          rig.rotateBy(Math.sign(gap) * Math.min(Math.abs(gap), 0.01), 0);
        }
        expect(rig.orbitDistance).toBeCloseTo(startDistance, 9);
        expect(worstStep).toBeLessThanOrEqual(NORMAL_STEP * 2);
        expect(travelled).toBeGreaterThan(300 * IDLE_YAW_RATE * 0.5);
      });
    }
  }
});

function setup(mode: CameraMode = 'orbit') {
  const rig = {
    mode,
    orbitAngles: { yaw: 0, pitch: 0.1 },
    canOrbitTo: vi.fn<Orbitable['canOrbitTo']>(() => true),
    rotateBy: vi.fn(),
  };
  return { rig, idle: new IdleOrbit(rig) };
}

function wait(idle: IdleOrbit, seconds: number) {
  for (let t = 0; t < seconds; t += 0.5) idle.update(0.5);
}

describe('IdleOrbit', () => {
  it('leaves the camera alone until the quiet period is over', () => {
    const { rig, idle } = setup();
    wait(idle, IDLE_AFTER_SECONDS - 1);
    expect(rig.rotateBy).not.toHaveBeenCalled();
    expect(idle.active).toBe(false);
  });

  it('starts orbiting after the quiet period', () => {
    const { rig, idle } = setup();
    wait(idle, IDLE_AFTER_SECONDS + 5);
    expect(idle.active).toBe(true);
    expect(rig.rotateBy).toHaveBeenCalled();
    const [yaw, pitch] = rig.rotateBy.mock.lastCall as [number, number];
    expect(yaw).not.toBe(0);
    expect(pitch).toBe(0);
  });

  it('eases in rather than starting at full speed', () => {
    const { rig, idle } = setup();
    wait(idle, IDLE_AFTER_SECONDS);
    idle.update(0.1);
    const first = Math.abs((rig.rotateBy.mock.calls[0] as [number, number])[0]);
    wait(idle, 10);
    const later = Math.abs((rig.rotateBy.mock.lastCall as [number, number])[0]) / 0.5;
    expect(first / 0.1).toBeLessThan(later);
  });

  it('stops at once on input and waits the full period again', () => {
    const { rig, idle } = setup();
    wait(idle, IDLE_AFTER_SECONDS + 5);
    idle.input();
    expect(idle.active).toBe(false);
    rig.rotateBy.mockClear();
    wait(idle, IDLE_AFTER_SECONDS - 1);
    expect(rig.rotateBy).not.toHaveBeenCalled();
  });

  it('does not orbit while focused on a fish or diving', () => {
    for (const mode of ['focus', 'dive'] as const) {
      const { rig, idle } = setup(mode);
      wait(idle, IDLE_AFTER_SECONDS * 2);
      expect(rig.rotateBy).not.toHaveBeenCalled();
    }
  });

  it('never orbits under reduced motion, and stops when it turns on', () => {
    const { rig, idle } = setup();
    idle.setReducedMotion(true);
    wait(idle, IDLE_AFTER_SECONDS * 2);
    expect(rig.rotateBy).not.toHaveBeenCalled();
    idle.setReducedMotion(false);
    wait(idle, IDLE_AFTER_SECONDS - 1);
    expect(rig.rotateBy).not.toHaveBeenCalled();
  });

  it('ignores bad frame times', () => {
    const { rig, idle } = setup();
    idle.update(Number.NaN);
    idle.update(-1);
    wait(idle, IDLE_AFTER_SECONDS - 1);
    expect(rig.rotateBy).not.toHaveBeenCalled();
  });
});

describe('IdleOrbit pausing and turning', () => {
  it('holds still and restarts the wait while paused', () => {
    const { rig, idle } = setup();
    for (let t = 0; t < IDLE_AFTER_SECONDS * 2; t += 0.5) idle.update(0.5, true);
    expect(rig.rotateBy).not.toHaveBeenCalled();
    wait(idle, IDLE_AFTER_SECONDS - 1);
    expect(rig.rotateBy).not.toHaveBeenCalled();
  });

  it('turns round when the room has no space further on', () => {
    const { rig, idle } = setup();
    wait(idle, IDLE_AFTER_SECONDS + 5);
    const before = Math.sign((rig.rotateBy.mock.lastCall as [number, number])[0]);
    rig.canOrbitTo.mockImplementation((yaw) => yaw < 0.1);
    rig.orbitAngles = { yaw: 0.05, pitch: 0.1 };
    idle.update(0.5);
    const after = Math.sign((rig.rotateBy.mock.lastCall as [number, number])[0]);
    expect(after).toBe(-before);
  });
});

describe('bindIdleInput', () => {
  it('treats pointer, wheel, key and touch input as activity until unbound', () => {
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
      const { idle } = setup();
      const target = new EventTarget();
      const stop = bindIdleInput(target, idle);
      wait(idle, IDLE_AFTER_SECONDS + 5);
      expect(idle.active).toBe(true);
      target.dispatchEvent(new Event(type));
      expect(idle.active).toBe(false);
      stop();
      wait(idle, IDLE_AFTER_SECONDS + 5);
      target.dispatchEvent(new Event(type));
      expect(idle.active).toBe(true);
    }
  });
});
