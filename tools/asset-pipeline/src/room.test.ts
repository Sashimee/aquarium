import { describe, expect, it } from 'vitest';
import {
  AMBIENCE_TUNING,
  LOD0_MAX_TRIANGLES,
  MOBILE_PROP_TRIANGLES,
  lodRatios,
  loadRooms,
  mobileTriangleTargets,
  roomAmbienceIds,
  roomAmbienceRecipe,
  roomHdriIds,
  roomHdriOutput,
  roomPropIds,
} from './room.ts';
import { resolve } from 'node:path';
import { ROOM_GPU_BUDGETS } from './room-budgets.ts';

const room = (id: string, furniture: string[]) =>
  ({ id, assets: { furniture } }) as Parameters<typeof mobileTriangleTargets>[0][number];

describe('mobileTriangleTargets', () => {
  it('keeps the LOD0 count of props in a room that already fits', () => {
    const targets = mobileTriangleTargets(
      [room('a', ['x', 'y'])],
      new Map([
        ['x', 3000],
        ['y', 4000],
      ]),
    );
    expect(targets.get('x')).toBe(3000);
    expect(targets.get('y')).toBe(4000);
  });

  it('scales every prop of an over-budget room by the same share', () => {
    const targets = mobileTriangleTargets(
      [room('a', ['x', 'y'])],
      new Map([
        ['x', 14_000],
        ['y', 14_000],
      ]),
    );
    expect(targets.get('x')).toBe(7000);
    expect(targets.get('y')).toBe(7000);
  });

  it('gives a shared prop the tightest scale of the rooms it stands in', () => {
    const targets = mobileTriangleTargets(
      [room('roomy', ['shared']), room('tight', ['shared', 'big'])],
      new Map([
        ['shared', 10_000],
        ['big', 20_000],
      ]),
      MOBILE_PROP_TRIANGLES,
    );
    const scale = MOBILE_PROP_TRIANGLES / 30_000;
    expect(targets.get('shared')).toBe(Math.floor(10_000 * scale));
    expect(targets.get('big')).toBe(Math.floor(20_000 * scale));
  });

  it('refuses a prop without a triangle count', () => {
    expect(() => mobileTriangleTargets([room('a', ['missing'])], new Map())).toThrow('missing');
  });
});

describe('MOBILE_PROP_TRIANGLES', () => {
  it('leaves the procedural shell room under the mobile triangle budget', () => {
    expect(MOBILE_PROP_TRIANGLES).toBeLessThan(ROOM_GPU_BUDGETS.mobile.triangles);
  });

  it('is the cap a room of heavier props is scaled down to', () => {
    const targets = mobileTriangleTargets(
      [room('a', ['x', 'y', 'z'])],
      new Map([
        ['x', 7000],
        ['y', 7000],
        ['z', 7000],
      ]),
    );
    const total = [...targets.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(MOBILE_PROP_TRIANGLES);
    expect(total).toBeGreaterThan(MOBILE_PROP_TRIANGLES - 3);
  });
});

describe('lodRatios', () => {
  it('leaves a light prop whole at LOD0 and steps down from there', () => {
    const [lod0, lod1, lod2] = lodRatios(2000, 2000);
    expect(lod0).toBe(1);
    expect(lod1).toBeLessThan(lod0);
    expect(lod2).toBeLessThan(lod1);
  });

  it('caps LOD0 at the triangle ceiling', () => {
    const [lod0] = lodRatios(70_000, 70_000);
    expect(lod0 * 70_000).toBeCloseTo(LOD0_MAX_TRIANGLES);
  });

  it('sizes LOD2 to the mobile target when that is the smaller level', () => {
    const [, , lod2] = lodRatios(20_000, 1000);
    expect(lod2 * 20_000).toBeCloseTo(1000);
  });

  it('never drops below the floor ratio and stays ordered', () => {
    const [lod0, lod1, lod2] = lodRatios(100_000, 10);
    expect(lod2).toBe(0.02);
    expect(lod0).toBeGreaterThanOrEqual(lod1);
    expect(lod1).toBeGreaterThanOrEqual(lod2);
  });
});

describe('room recipes', () => {
  it('cuts a 14 s loop of the whole recording unless tuned', () => {
    const recipe = roomAmbienceRecipe('freesound-329533');
    expect(recipe.loop).toEqual({ loopS: 14, crossfadeS: 1 });
    expect(recipe.role).toBe('room-ambience');
  });

  it('restricts the stationary search of a tuned recording', () => {
    const [id, tuning] = Object.entries(AMBIENCE_TUNING)[0] ?? [];
    expect(id).toBeDefined();
    expect(roomAmbienceRecipe(id ?? '').loop?.searchS).toEqual(tuning?.searchS);
  });

  it('names every room hdri so the api never mistakes it for a hashed bundle', () => {
    const hashed = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
    const rooms = loadRooms(resolve(import.meta.dirname, '../../..'));
    for (const id of roomHdriIds(rooms)) {
      const output = roomHdriOutput(id);
      expect(output).not.toContain('-');
      expect(hashed.test(`assets/${output}`)).toBe(false);
    }
  });

  it('lists each prop, hdri and ambience once, sorted', () => {
    const rooms = loadRooms(resolve(import.meta.dirname, '../../..'));
    for (const ids of [roomPropIds(rooms), roomHdriIds(rooms), roomAmbienceIds(rooms)]) {
      expect(ids).toEqual([...new Set(ids)].sort());
      expect(ids.length).toBeGreaterThan(0);
    }
  });
});
