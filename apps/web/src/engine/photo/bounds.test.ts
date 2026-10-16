import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../tank/dimensions';
import { clampEye, moveEye, photoBounds, regionOf } from './bounds';

const bounds = photoBounds(DEFAULT_TANK);
const { solid, room, water, waterVolume } = bounds;
const FRONT = { x: 0, y: 0.35, z: 1.6 };

describe('photoBounds', () => {
  it('nests the water inside the tank inside the room', () => {
    for (const axis of ['x', 'z'] as const) {
      expect(room.min[axis]).toBeLessThan(solid.min[axis]);
      expect(solid.min[axis]).toBeLessThan(waterVolume.min[axis]);
      expect(waterVolume.min[axis]).toBeLessThan(water.min[axis]);
      expect(water.max[axis]).toBeLessThan(waterVolume.max[axis]);
      expect(waterVolume.max[axis]).toBeLessThan(solid.max[axis]);
      expect(solid.max[axis]).toBeLessThan(room.max[axis]);
    }
    expect(water.min.y).toBeGreaterThan(DEFAULT_TANK.glass + DEFAULT_TANK.substrateBack);
    expect(water.max.y).toBeLessThan(waterVolume.max.y);
    expect(solid.max.y).toBeGreaterThan(DEFAULT_TANK.height);
    expect(room.min.y).toBeLessThan(0);
  });
});

describe('regionOf', () => {
  it('is water inside the water and room everywhere else, the glass included', () => {
    expect(regionOf({ x: 0, y: 0.25, z: 0 }, bounds)).toBe('water');
    expect(regionOf(FRONT, bounds)).toBe('room');
    expect(regionOf({ x: 0, y: 0.25, z: waterVolume.max.z + 0.002 }, bounds)).toBe('room');
    expect(regionOf({ x: 0, y: DEFAULT_TANK.height + 0.01, z: 0 }, bounds)).toBe('room');
  });
});

describe('clampEye', () => {
  it('leaves a room eye clear of the tank where it is', () => {
    expect(clampEye(FRONT, 'room', bounds)).toEqual(FRONT);
  });

  it('keeps a room eye inside the room', () => {
    const eye = clampEye({ x: 40, y: -5, z: 2 }, 'room', bounds);
    expect(eye).toEqual({ x: room.max.x, y: room.min.y, z: 2 });
  });

  it('pushes a room eye out of the tank through the nearest face', () => {
    const nearFront = clampEye({ x: 0.1, y: 0.25, z: solid.max.z - 0.01 }, 'room', bounds);
    expect(nearFront).toEqual({ x: 0.1, y: 0.25, z: solid.max.z });
    const nearTop = clampEye({ x: 0.1, y: solid.max.y - 0.01, z: 0 }, 'room', bounds);
    expect(nearTop).toEqual({ x: 0.1, y: solid.max.y, z: 0 });
    const nearLeft = clampEye({ x: solid.min.x + 0.01, y: -0.3, z: 0 }, 'room', bounds);
    expect(nearLeft).toEqual({ x: solid.min.x, y: -0.3, z: 0 });
  });

  it('keeps a water eye off the glass, the sand and the surface', () => {
    const eye = clampEye({ x: 5, y: -1, z: -5 }, 'water', bounds);
    expect(eye).toEqual({ x: water.max.x, y: water.min.y, z: water.min.z });
    expect(clampEye({ x: 0, y: 2, z: 0 }, 'water', bounds).y).toBe(water.max.y);
  });

  it('refuses a position that is not a number', () => {
    expect(() => clampEye({ x: Number.NaN, y: 0, z: 0 }, 'room', bounds)).toThrow(RangeError);
  });
});

describe('moveEye', () => {
  it('moves freely through the room', () => {
    const to = { x: 0.5, y: 0.6, z: 1.2 };
    expect(moveEye(FRONT, to, 'room', bounds)).toEqual(to);
  });

  it('stops a long step at the front glass instead of tunnelling out the back', () => {
    const eye = moveEye(FRONT, { x: 0, y: 0.35, z: -1.6 }, 'room', bounds);
    expect(eye).toEqual({ x: 0, y: 0.35, z: solid.max.z });
  });

  it('holds an eye resting on the glass there, and lets it move along it', () => {
    const resting = { x: 0, y: 0.3, z: solid.max.z };
    expect(moveEye(resting, { x: 0, y: 0.3, z: -1 }, 'room', bounds)).toEqual(resting);
    expect(moveEye(resting, { x: 0.2, y: 0.32, z: solid.max.z }, 'room', bounds)).toEqual({
      x: 0.2,
      y: 0.32,
      z: solid.max.z,
    });
  });

  it('passes beside the tank without touching it', () => {
    const from = { x: solid.max.x + 0.3, y: 0.3, z: 1 };
    const to = { x: solid.max.x + 0.3, y: 0.3, z: -1 };
    expect(moveEye(from, to, 'room', bounds)).toEqual(to);
  });

  it('slides along the glass a step meets at an angle', () => {
    const eye = moveEye(FRONT, { x: 0.3, y: 0.3, z: 0 }, 'room', bounds);
    expect(eye).toEqual({ x: 0.3, y: 0.3, z: solid.max.z });
  });

  it('lands on the lid from above', () => {
    const eye = moveEye({ x: 0, y: 1.2, z: 0 }, { x: 0.1, y: 0.2, z: 0 }, 'room', bounds);
    expect(eye).toEqual({ x: 0.1, y: solid.max.y, z: 0 });
  });

  it('slides along a side the step enters last', () => {
    const from = { x: solid.max.x + 0.5, y: 0.3, z: solid.max.z + 0.1 };
    const eye = moveEye(
      from,
      { x: solid.max.x - 0.2, y: 0.3, z: solid.max.z - 0.3 },
      'room',
      bounds,
    );
    expect(eye.x).toBe(solid.max.x);
    expect(eye.z).toBeCloseTo(solid.max.z - 0.3, 10);
  });

  it('keeps a water eye in the water however far it is moved', () => {
    const eye = moveEye({ x: 0, y: 0.25, z: 0 }, { x: 0, y: 0.25, z: 3 }, 'water', bounds);
    expect(eye).toEqual({ x: 0, y: 0.25, z: water.max.z });
  });

  it('refuses a target that is not a number', () => {
    expect(() =>
      moveEye(FRONT, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }, 'room', bounds),
    ).toThrow(RangeError);
  });
});
