import { describe, expect, it, vi } from 'vitest';
import {
  CameraRig,
  distanceToBoxExit,
  type CameraLike,
  type CameraMode,
  type TankBounds,
  orbitDistanceFor,
  tankBounds,
  type Vec3,
} from './camera';
import { framingScale, TANK_DIMENSIONS, type TankDimensions } from '../engine/tank/dimensions';
import { applyCameraKey } from './controls';

const BOUNDS: TankBounds = {
  halfLength: 0.6,
  halfDepth: 0.25,
  height: 0.5,
  waterTop: 0.47,
  floor: 0.1,
};

function fakeCamera() {
  const camera = {
    pos: { x: 0, y: 0, z: 0 } as Vec3,
    look: { x: 0, y: 0, z: 0 } as Vec3,
    position: {
      set(x: number, y: number, z: number) {
        camera.pos = { x, y, z };
      },
    },
    lookAt(x: number, y: number, z: number) {
      camera.look = { x, y, z };
    },
  };
  return camera satisfies CameraLike & { pos: Vec3; look: Vec3 };
}

function settle(rig: CameraRig, seconds = 5) {
  for (let t = 0; t < seconds; t += 1 / 60) rig.update(1 / 60);
}

function insideGlass(p: Vec3): boolean {
  return (
    Math.abs(p.x) < BOUNDS.halfLength &&
    Math.abs(p.z) < BOUNDS.halfDepth &&
    p.y > 0 &&
    p.y < BOUNDS.height
  );
}

describe('distanceToBoxExit', () => {
  const min = { x: -1, y: -1, z: -1 };
  const max = { x: 1, y: 1, z: 1 };
  it('finds the nearest face along the ray', () => {
    expect(distanceToBoxExit({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, min, max)).toBeCloseTo(1);
    expect(distanceToBoxExit({ x: 0.5, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, min, max)).toBeCloseTo(
      1.5,
    );
    const d = Math.SQRT1_2;
    expect(distanceToBoxExit({ x: 0, y: 0, z: 0 }, { x: d, y: d, z: 0 }, min, max)).toBeCloseTo(
      Math.SQRT2,
    );
  });
  it('is zero when the origin is already on or beyond the exit face', () => {
    expect(distanceToBoxExit({ x: 2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, min, max)).toBe(0);
  });
});

describe('CameraRig orbit', () => {
  it('starts outside the glass looking at the tank centre', () => {
    const cam = fakeCamera();
    new CameraRig(cam, BOUNDS);
    expect(insideGlass(cam.pos)).toBe(false);
    expect(cam.look).toEqual({ x: 0, y: 0.25, z: 0 });
  });

  it('never lets the eye into the tank however far you zoom or whichever way you look', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    for (let yaw = -3; yaw <= 3; yaw += 0.5) {
      for (const pitch of [-1, 0, 0.5, 1.5]) {
        rig.setOrbit(yaw, pitch, 0.01);
        rig.update(0.016);
        expect(insideGlass(cam.pos)).toBe(false);
      }
    }
  });

  it('clamps the pitch and the zoom range', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.rotateBy(0, 100);
    rig.zoom(1000);
    rig.update(0.016);
    expect(Math.hypot(cam.pos.x, cam.pos.y - 0.25, cam.pos.z)).toBeLessThanOrEqual(4 + 1e-6);
    expect(cam.pos.y).toBeLessThan(0.25 + 4);
    rig.rotateBy(0, -100);
    rig.update(0.016);
    expect(cam.pos.y).toBeGreaterThan(0);
  });

  it('dragging right orbits the camera left (the scene follows the finger)', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.setOrbit(0, 0.1, 1.6);
    rig.drag(100, 0);
    rig.update(0.016);
    expect(cam.pos.x).toBeLessThan(0);
  });

  it('ignores non-positive or non-finite zoom factors', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.update(0.016);
    const before = { ...cam.pos };
    for (const f of [0, -1, NaN, Infinity]) rig.zoom(f);
    rig.update(0.016);
    expect(cam.pos).toEqual(before);
  });

  it('smooths towards the goal instead of jumping', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS);
    rig.setOrbit(0, 0.1, 1.6);
    settle(rig, 1);
    rig.setOrbit(Math.PI / 2, 0.1, 1.6);
    rig.update(1 / 60);
    expect(cam.pos.x).toBeGreaterThan(0);
    expect(cam.pos.x).toBeLessThan(1.5);
    settle(rig, 2);
    expect(cam.pos.x).toBeCloseTo(1.6 * Math.cos(0.1), 1);
  });
});

describe('CameraRig reduced motion', () => {
  it('snaps to the goal in a single frame', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.setOrbit(Math.PI / 2, 0.1, 1.6);
    rig.update(1 / 60);
    expect(cam.pos.x).toBeCloseTo(1.6 * Math.cos(0.1), 3);
  });

  it('turns more slowly per pixel than the default', () => {
    const normal = fakeCamera();
    const slow = fakeCamera();
    const a = new CameraRig(normal, BOUNDS, { reducedMotion: false });
    const b = new CameraRig(slow, BOUNDS, { reducedMotion: true });
    a.drag(100, 0);
    b.drag(100, 0);
    settle(a, 2);
    b.update(1 / 60);
    expect(Math.abs(slow.pos.x)).toBeLessThan(Math.abs(normal.pos.x));
  });

  it('can be switched on at runtime', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS);
    rig.setReducedMotion(true);
    rig.setOrbit(1, 0.1, 1.6);
    rig.update(1 / 60);
    expect(cam.pos.x).toBeCloseTo(1.6 * Math.cos(0.1) * Math.sin(1), 3);
  });
});

describe('CameraRig focus', () => {
  it('follows a moving target and looks at it', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    const fish: Vec3 = { x: 0.1, y: 0.3, z: 0 };
    rig.focusOn(() => fish);
    rig.update(0.016);
    expect(cam.look).toEqual(fish);
    fish.x = -0.3;
    rig.update(0.016);
    expect(cam.look.x).toBeCloseTo(-0.3);
    expect(rig.mode).toBe('focus');
  });

  it('falls back to orbit when the target disappears', () => {
    const modes: CameraMode[] = [];
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, {
      reducedMotion: true,
      onModeChange: (m) => modes.push(m),
    });
    let alive = true;
    rig.focusOn(() => (alive ? { x: 0, y: 0.3, z: 0 } : null));
    alive = false;
    rig.update(0.016);
    expect(rig.mode).toBe('orbit');
    expect(modes).toEqual(['focus', 'orbit']);
    expect(cam.look).toEqual({ x: 0, y: 0.25, z: 0 });
  });

  it('refuses to focus on a target that is already gone', () => {
    const rig = new CameraRig(fakeCamera(), BOUNDS);
    rig.focusOn(() => null);
    expect(rig.mode).toBe('orbit');
  });

  it('keeps the zoom within the focus range', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.focusOn(() => ({ x: 0, y: 0.3, z: 0 }));
    rig.zoom(1e-6);
    rig.update(0.016);
    const near = Math.hypot(cam.pos.x, cam.pos.y - 0.3, cam.pos.z);
    expect(near).toBeGreaterThanOrEqual(0.12 - 1e-6);
    rig.zoom(1e6);
    rig.update(0.016);
    expect(Math.hypot(cam.pos.x, cam.pos.y - 0.3, cam.pos.z)).toBeLessThanOrEqual(1.5 + 1e-6);
  });

  it('exit returns to orbit', () => {
    const rig = new CameraRig(fakeCamera(), BOUNDS, { reducedMotion: true });
    rig.focusOn(() => ({ x: 0, y: 0.3, z: 0 }));
    rig.exit();
    expect(rig.mode).toBe('orbit');
  });
});

describe('CameraRig robustness', () => {
  it('ignores NaN and infinite frame times instead of corrupting the view', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS);
    rig.update(NaN);
    rig.update(Infinity);
    rig.update(-1);
    rig.update(0.016);
    expect(Number.isFinite(cam.pos.x + cam.pos.y + cam.pos.z)).toBe(true);
  });

  it('converges to the same view whether time arrives in small or large steps', () => {
    const run = (step: number) => {
      const cam = fakeCamera();
      const rig = new CameraRig(cam, BOUNDS);
      rig.setOrbit(1.2, 0.3, 2);
      for (let t = 0; t < 2; t += step) rig.update(step);
      return cam.pos;
    };
    const fine = run(1 / 120);
    const coarse = run(1 / 20);
    expect(coarse.x).toBeCloseTo(fine.x, 2);
    expect(coarse.y).toBeCloseTo(fine.y, 2);
    expect(coarse.z).toBeCloseTo(fine.z, 2);
  });

  it('keeps a follow camera in the water when the fish hugs the glass or the substrate', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    for (const fish of [
      { x: 0, y: 0.3, z: 0.24 },
      { x: 0.59, y: 0.3, z: 0 },
      { x: 0, y: 0.12, z: 0 },
    ]) {
      rig.focusOn(() => fish);
      for (const yaw of [0, 1.5, 3, -1.5]) {
        rig.setOrbit(yaw, 0.2, 1);
        rig.update(0.016);
        expect(insideGlass(cam.pos)).toBe(true);
        expect(cam.pos.y).toBeGreaterThanOrEqual(BOUNDS.floor);
      }
    }
  });
});

describe('CameraRig dive', () => {
  it('puts the eye inside the water, continuing the current view direction', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.setOrbit(0, 0, 1.6);
    rig.update(0.016);
    rig.dive();
    rig.update(0.016);
    expect(rig.mode).toBe('dive');
    expect(insideGlass(cam.pos)).toBe(true);
    expect(cam.pos.z).toBeGreaterThan(0);
    expect(cam.look.z).toBeLessThan(cam.pos.z);
    expect(cam.pos.y).toBeGreaterThanOrEqual(BOUNDS.floor);
    expect(cam.pos.y).toBeLessThanOrEqual(BOUNDS.waterTop);
  });

  it('keeps the eye inside the water volume while moving and looking around', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.dive();
    for (let i = 0; i < 40; i++) rig.zoom(0.2);
    rig.update(0.016);
    expect(insideGlass(cam.pos)).toBe(true);
    for (let i = 0; i < 40; i++) rig.zoom(5);
    rig.update(0.016);
    expect(insideGlass(cam.pos)).toBe(true);
    rig.rotateBy(0, 50);
    rig.update(0.016);
    expect(cam.look.y - cam.pos.y).toBeLessThanOrEqual(1);
  });

  it('exiting dive restores the outside orbit view', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.dive();
    rig.update(0.016);
    rig.exit();
    rig.update(0.016);
    expect(insideGlass(cam.pos)).toBe(false);
    expect(rig.mode).toBe('orbit');
  });

  it('diving twice is a no-op and reports the mode change once', () => {
    const onModeChange = vi.fn();
    const rig = new CameraRig(fakeCamera(), BOUNDS, { onModeChange });
    rig.dive();
    rig.dive();
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it('glides between modes when motion is allowed', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS);
    settle(rig, 1);
    const outside = { ...cam.pos };
    rig.dive();
    rig.update(1 / 60);
    expect(
      Math.hypot(cam.pos.x - outside.x, cam.pos.y - outside.y, cam.pos.z - outside.z),
    ).toBeLessThan(0.2);
    settle(rig, 4);
    expect(insideGlass(cam.pos)).toBe(true);
  });
});

function insideTank(p: Vec3, d: TankDimensions): boolean {
  return Math.abs(p.x) < d.length / 2 && Math.abs(p.z) < d.depth / 2 && p.y > 0 && p.y < d.height;
}

function rigFor(d: TankDimensions, cam = fakeCamera()) {
  const rig = new CameraRig(cam, tankBounds(d), {
    reducedMotion: true,
    orbitDistance: orbitDistanceFor(framingScale(d)),
  });
  return { rig, cam };
}

describe('tankBounds', () => {
  it('reads the glass, the waterline and the dive floor from the tank', () => {
    const d = TANK_DIMENSIONS.nano30;
    expect(tankBounds(d)).toEqual({
      halfLength: d.length / 2,
      halfDepth: d.depth / 2,
      height: d.height,
      waterTop: d.height - d.freeboard,
      floor: d.substrateBack + 0.05,
    });
  });
});

describe('CameraRig setBounds', () => {
  it('stands back by the framing scale of the tank it was built for', () => {
    for (const size of ['nano30', 'standard', 'long300'] as const) {
      const d = TANK_DIMENSIONS[size];
      const { rig, cam } = rigFor(d);
      rig.update(0.016);
      const toEye = Math.hypot(
        cam.pos.x - cam.look.x,
        cam.pos.y - cam.look.y,
        cam.pos.z - cam.look.z,
      );
      expect(toEye).toBeCloseTo(orbitDistanceFor(framingScale(d)), 6);
      expect(cam.look.y).toBeCloseTo(d.height / 2, 6);
    }
  });

  it('frames another tank after a resize and keeps the eye outside its glass', () => {
    const nano = TANK_DIMENSIONS.nano30;
    const { rig, cam } = rigFor(TANK_DIMENSIONS.standard);
    rig.setBounds(tankBounds(nano), orbitDistanceFor(framingScale(nano)));
    rig.update(0.016);
    expect(cam.look.y).toBeCloseTo(nano.height / 2, 6);
    expect(Math.hypot(cam.pos.x, cam.pos.z)).toBeCloseTo(
      orbitDistanceFor(framingScale(nano)) * Math.cos(0.1),
      6,
    );
    for (let i = 0; i < 40; i++) rig.zoom(0.2);
    for (const yaw of [0, 1, 2, 3, 4, 5]) {
      rig.setOrbit(yaw, 0.6, 0.1);
      rig.update(0.016);
      expect(insideTank(cam.pos, nano)).toBe(false);
    }
  });

  it('clamps against a larger tank too', () => {
    const big = TANK_DIMENSIONS.long300;
    const { rig, cam } = rigFor(TANK_DIMENSIONS.nano30);
    rig.setBounds(tankBounds(big), orbitDistanceFor(framingScale(big)));
    for (const yaw of [0, 0.7, 1.6, 2.5, 3.5, 4.5]) {
      rig.setOrbit(yaw, 0.2, 0.1);
      rig.update(0.016);
      expect(insideTank(cam.pos, big)).toBe(false);
    }
  });

  it('pulls a diving eye back inside the smaller water volume', () => {
    const nano = TANK_DIMENSIONS.nano30;
    const { rig, cam } = rigFor(TANK_DIMENSIONS.long300);
    rig.dive();
    rig.zoom(0.4);
    rig.setBounds(tankBounds(nano), orbitDistanceFor(framingScale(nano)));
    rig.update(0.016);
    expect(rig.mode).toBe('dive');
    expect(insideTank(cam.pos, nano)).toBe(true);
    expect(cam.pos.y).toBeGreaterThanOrEqual(tankBounds(nano).floor);
    expect(cam.pos.y).toBeLessThanOrEqual(tankBounds(nano).waterTop);
  });

  it('ends up where a fresh rig would after switching sizes twice', () => {
    const [nano, big, std] = [
      TANK_DIMENSIONS.nano30,
      TANK_DIMENSIONS.long300,
      TANK_DIMENSIONS.standard,
    ];
    const { rig, cam } = rigFor(std);
    rig.setBounds(tankBounds(big), orbitDistanceFor(framingScale(big)));
    rig.setBounds(tankBounds(nano), orbitDistanceFor(framingScale(nano)));
    rig.update(0.016);
    const fresh = rigFor(nano);
    fresh.rig.update(0.016);
    expect(cam.pos).toEqual(fresh.cam.pos);
    expect(cam.look).toEqual(fresh.cam.look);
    for (let i = 0; i < 40; i++) {
      rig.zoom(0.2);
      fresh.rig.zoom(0.2);
    }
    rig.update(0.016);
    fresh.rig.update(0.016);
    expect(cam.pos).toEqual(fresh.cam.pos);
  });
});

describe('applyCameraKey', () => {
  it('maps arrows, zoom keys and escape; leaves other keys alone', () => {
    const cam = fakeCamera();
    const rig = new CameraRig(cam, BOUNDS, { reducedMotion: true });
    rig.dive();
    expect(applyCameraKey(rig, 'Escape')).toBe(true);
    expect(rig.mode).toBe('orbit');
    expect(applyCameraKey(rig, 'ArrowLeft')).toBe(true);
    expect(applyCameraKey(rig, '+')).toBe(true);
    expect(applyCameraKey(rig, '-')).toBe(true);
    expect(applyCameraKey(rig, 'a')).toBe(false);
    expect(applyCameraKey(rig, 'Tab')).toBe(false);
  });
});
