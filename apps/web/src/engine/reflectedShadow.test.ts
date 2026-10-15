import { describe, expect, it } from 'vitest';
import { ReflectedShadow, type ReflectedShadowMap } from './reflectedShadow';

function shadowMap(size: number): ReflectedShadowMap & { mapSize: { x: number } } {
  return { autoUpdate: true, mapSize: { x: size } };
}

/** Runs one frame and returns whether the reflection pass would redraw the shadow map. */
function frame(
  sync: ReflectedShadow,
  shadow: ReflectedShadowMap,
  drew: boolean,
  castShadow = true,
): boolean {
  let redraws = false;
  sync.draw(shadow, castShadow, () => {
    redraws = shadow.autoUpdate;
    return drew;
  });
  return redraws;
}

describe('ReflectedShadow', () => {
  it('redraws the shadow in the first drawn frame and then reuses the scene pass map', () => {
    const sync = new ReflectedShadow();
    const shadow = shadowMap(1024);
    expect(frame(sync, shadow, true)).toBe(true);
    expect(frame(sync, shadow, true)).toBe(false);
    expect(shadow.autoUpdate).toBe(true);
  });

  it('redraws once after a resize', () => {
    const sync = new ReflectedShadow();
    const shadow = shadowMap(1024);
    frame(sync, shadow, true);
    shadow.mapSize.x = 2048;
    expect(frame(sync, shadow, true)).toBe(true);
    expect(frame(sync, shadow, true)).toBe(false);
  });

  it('still redraws after a resize that happened while the reflection was skipped', () => {
    const sync = new ReflectedShadow();
    const shadow = shadowMap(1024);
    frame(sync, shadow, true);
    shadow.mapSize.x = 2048;
    frame(sync, shadow, false);
    frame(sync, shadow, false);
    expect(frame(sync, shadow, true)).toBe(true);
    expect(frame(sync, shadow, true)).toBe(false);
  });

  it('redraws when the light starts casting again', () => {
    const sync = new ReflectedShadow();
    const shadow = shadowMap(1024);
    frame(sync, shadow, true);
    frame(sync, shadow, true, false);
    expect(frame(sync, shadow, true)).toBe(true);
    expect(frame(sync, shadow, true)).toBe(false);
  });

  it('never turns on a shadow update the caller had off', () => {
    const sync = new ReflectedShadow();
    const shadow = shadowMap(1024);
    shadow.autoUpdate = false;
    expect(frame(sync, shadow, true)).toBe(false);
    expect(shadow.autoUpdate).toBe(false);
  });

  it('restores autoUpdate when the pass throws', () => {
    const sync = new ReflectedShadow();
    const shadow = shadowMap(1024);
    expect(() =>
      sync.draw(shadow, true, () => {
        throw new Error('pass failed');
      }),
    ).toThrow('pass failed');
    expect(shadow.autoUpdate).toBe(true);
    expect(frame(sync, shadow, true)).toBe(true);
  });
});
