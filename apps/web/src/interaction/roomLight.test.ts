import type { RoomId } from '@aquarium/shared';
import { CubeUVReflectionMapping, Group, RenderTarget } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { LitRoom } from '../engine/room';
import { RoomLight } from '../engine/room';
import { minuteOfDay } from '../engine/daylight';
import { roomLightAt } from '../engine/room';
import { weatherAt } from '../engine/room/weather';
import { bindRoomLight } from './roomLight';

function setup(initial: RoomId | null = null, clock: number | null = null, engineRoom = true) {
  let shown: RoomId | null = initial;
  const shownListeners = new Set<() => void>();
  const stage: LitRoom = { group: new Group(), pane: null, layout: null };
  let hasStage = engineRoom;
  const frames = new Set<() => void>();
  const texture = new RenderTarget(64, 64).texture;
  texture.mapping = CubeUVReflectionMapping;
  const created: RoomLight[] = [];
  const seeds: number[] = [];
  let seed = 7;
  const seedListeners = new Set<() => void>();
  let nowMs = Date.UTC(2026, 9, 19, 12);
  const handle = bindRoomLight({
    shown: {
      snapshot: () => shown,
      subscribe: (cb) => {
        shownListeners.add(cb);
        return () => shownListeners.delete(cb);
      },
    },
    room: () => (hasStage ? stage : null),
    seed: {
      current: () => seed,
      subscribe: (cb) => {
        seedListeners.add(cb);
        return () => seedListeners.delete(cb);
      },
    },
    create: (made) => {
      seeds.push(made);
      const light = new RoomLight({ environment: texture, tier: 'high', seed: made });
      created.push(light);
      return light;
    },
    tier: () => 'high',
    hood: () => 1,
    clock: () => clock ?? minuteOfDay(new Date(nowMs)),
    now: () => nowMs,
    onFrame: (cb) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
  });
  const frame = () => frames.forEach((cb) => cb());
  const show = (next: RoomId | null) => {
    shown = next;
    shownListeners.forEach((cb) => cb());
  };
  const changeSeed = (next: number) => {
    seed = next;
    seedListeners.forEach((cb) => cb());
  };
  const setNow = (ms: number) => {
    nowMs = ms;
  };
  const engineGetsRoom = () => {
    hasStage = true;
    handle.sync();
  };
  return {
    handle,
    created,
    frame,
    frames,
    seeds,
    show,
    changeSeed,
    setNow,
    seedListeners,
    engineGetsRoom,
  };
}

describe('bindRoomLight', () => {
  it('creates no light while no room is shown', () => {
    const { handle, created, frame } = setup(null);
    frame();
    expect(handle.light).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('mounts a light for a shown room and feeds it each frame', () => {
    const { handle, created, frame } = setup('room-office');
    expect(created).toHaveLength(1);
    expect(handle.light?.state).toBeNull();
    frame();
    expect(handle.light?.state).not.toBeNull();
    expect(handle.light?.weather).not.toBeNull();
  });

  it('waits for the engine room and lights it once it exists', () => {
    const { handle, created, engineGetsRoom } = setup('room-living', null, false);
    expect(created).toHaveLength(0);
    engineGetsRoom();
    expect(handle.light).toBe(created[0]);
  });

  it('mounts on choosing a room and disposes on choosing none', () => {
    const { show, handle, created } = setup(null);
    show('room-living');
    expect(handle.light).toBe(created[0]);
    const dispose = vi.spyOn(created[0] as RoomLight, 'dispose');
    show(null);
    expect(dispose).toHaveBeenCalledOnce();
    expect(handle.light).toBeNull();
    show('room-office');
    expect(created).toHaveLength(2);
  });

  it('keeps one light when switching between rooms', () => {
    const { show, created } = setup('room-office');
    show('room-living');
    expect(created).toHaveLength(1);
  });

  it('pins the sun to ?clock= whatever the wall clock says', () => {
    const { handle, frame, setNow } = setup('room-office', 22 * 60);
    frame();
    const pinned = handle.light?.state;
    expect(pinned?.sun.toSun[1]).toBeLessThan(0);
    setNow(Date.UTC(2026, 9, 19, 3));
    frame();
    expect(handle.light?.state).toEqual(
      roomLightAt(22 * 60, weatherAt(Date.UTC(2026, 9, 19, 12), 7)),
    );
  });

  it('follows the wall clock when no clock is pinned', () => {
    const { handle, frame } = setup('room-office');
    frame();
    const weather = weatherAt(Date.UTC(2026, 9, 19, 12), 7);
    expect(handle.light?.state).toEqual(
      roomLightAt(minuteOfDay(new Date(Date.UTC(2026, 9, 19, 12))), weather),
    );
  });

  it('makes the light with the tank seed and rebuilds it when the tank changes', () => {
    const { handle, created, seeds, changeSeed } = setup('room-office');
    expect(seeds).toEqual([7]);
    const first = created[0] as RoomLight;
    changeSeed(99);
    expect(seeds).toEqual([7, 99]);
    expect(() => first.update({ nowMs: 0, minute: 0, hood: 1 })).toThrow(/after dispose/);
    expect(handle.light).toBe(created[1]);
  });

  it('does not build a light for a seed change while no room is shown', () => {
    const { created, changeSeed } = setup(null);
    changeSeed(5);
    expect(created).toHaveLength(0);
  });

  it('disposes the light and stops following frames', () => {
    const { handle, frames, seedListeners } = setup('room-office');
    const light = handle.light as RoomLight;
    handle.dispose();
    expect(frames.size).toBe(0);
    expect(seedListeners.size).toBe(0);
    expect(() => light.update({ nowMs: 0, minute: 0, hood: 1 })).toThrow(/after dispose/);
  });
});
