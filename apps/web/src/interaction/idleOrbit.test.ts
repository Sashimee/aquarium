import { describe, expect, it, vi } from 'vitest';
import { TANK_DIMENSIONS, framingScale } from '../engine/tank/dimensions';
import { planRoom } from '../scene/room/layout';
import { CameraRig, orbitDistanceFor, tankBounds, type CameraMode } from './camera';
import { IDLE_AFTER_SECONDS, IdleOrbit, bindIdleInput } from './idleOrbit';
import { roomVolume } from './roomLimit';

describe('IdleOrbit on the real rig', () => {
  it('keeps the eye inside the room and outside the glass through a long drift', () => {
    const d = TANK_DIMENSIONS.standard;
    const { shell } = planRoom('living-room', d);
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
    for (let t = 0; t < IDLE_AFTER_SECONDS + 300; t += 1 / 30) {
      idle.update(1 / 30);
      rig.update(1 / 30);
      const { x, y, z } = camera.pos;
      expect(x).toBeGreaterThanOrEqual(shell.min[0]);
      expect(x).toBeLessThanOrEqual(shell.max[0]);
      expect(y).toBeGreaterThanOrEqual(shell.min[1]);
      expect(y).toBeLessThanOrEqual(shell.max[1]);
      expect(z).toBeGreaterThanOrEqual(shell.min[2]);
      expect(z).toBeLessThanOrEqual(shell.max[2]);
      const insideGlass =
        Math.abs(x) < b.halfLength && Math.abs(z) < b.halfDepth && y > b.floor && y < b.waterTop;
      expect(insideGlass).toBe(false);
    }
  });
});

function setup(mode: CameraMode = 'orbit') {
  const rig = { mode, rotateBy: vi.fn() };
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
