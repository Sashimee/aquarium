import { CubeUVReflectionMapping, RenderTarget } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { RoomLight } from '../engine/room';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { RoomBackdrop } from '../scene/room/RoomBackdrop';
import { RoomPreference } from '../scene/room/preference';
import { bindRoomLight, minutesOfDay } from './roomLight';

function setup(initial?: 'office' | 'living-room', clock: number | null = null) {
  const store = new Map<string, string>();
  if (initial) store.set('aquarium.room', initial);
  const preference = new RoomPreference({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
  });
  const backdrop = new RoomBackdrop();
  backdrop.update({
    choice: preference.snapshot(),
    tank: TANK_DIMENSIONS.standard,
    tier: 'high',
  });
  const frames = new Set<() => void>();
  const texture = new RenderTarget(64, 64).texture;
  texture.mapping = CubeUVReflectionMapping;
  const created: RoomLight[] = [];
  const handle = bindRoomLight({
    preference,
    backdrop,
    create: () => {
      const light = new RoomLight({ environment: texture, tier: 'high', seed: 0 });
      created.push(light);
      return light;
    },
    tier: () => 'high',
    hood: () => 1,
    clock,
    now: () => Date.UTC(2026, 9, 19, 12),
    onFrame: (cb) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
  });
  const frame = () => frames.forEach((cb) => cb());
  return { preference, handle, created, frame, frames };
}

describe('bindRoomLight', () => {
  it('creates no light while the choice is none', () => {
    const { handle, created, frame } = setup();
    frame();
    expect(handle.light).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('mounts a light for a stored room and feeds it each frame', () => {
    const { handle, created, frame } = setup('office');
    expect(created).toHaveLength(1);
    expect(handle.light?.state).toBeNull();
    frame();
    expect(handle.light?.state).not.toBeNull();
    expect(handle.light?.weather).not.toBeNull();
  });

  it('mounts on choosing a room and disposes on choosing none', () => {
    const { preference, handle, created } = setup();
    preference.set('living-room');
    expect(handle.light).toBe(created[0]);
    const dispose = vi.spyOn(created[0] as RoomLight, 'dispose');
    preference.set('none');
    expect(dispose).toHaveBeenCalledOnce();
    expect(handle.light).toBeNull();
    preference.set('office');
    expect(created).toHaveLength(2);
  });

  it('keeps one light when switching between rooms', () => {
    const { preference, created } = setup('office');
    preference.set('living-room');
    expect(created).toHaveLength(1);
  });

  it('pins the sun to ?clock= instead of the wall clock', () => {
    const { handle, frame } = setup('office', 22 * 60);
    frame();
    const night = handle.light?.state?.sun.toSun[1] ?? 1;
    expect(night).toBeLessThan(0);
  });

  it('disposes the light and stops following frames', () => {
    const { handle, frames } = setup('office');
    const light = handle.light as RoomLight;
    handle.dispose();
    expect(frames.size).toBe(0);
    expect(() => light.update({ nowMs: 0, minute: 0, hood: 1 })).toThrow(/after dispose/);
  });
});

describe('minutesOfDay', () => {
  it('reads local minutes after midnight', () => {
    const d = new Date(2026, 9, 19, 13, 30, 30);
    expect(minutesOfDay(d.getTime())).toBeCloseTo(13 * 60 + 30.5);
  });
});
