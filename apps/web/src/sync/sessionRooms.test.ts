import type { RoomId, Tank } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../ui/api';
import { recordBus, speciesFixture, tankFixture, TANK_A } from './fixtures';
import { TankSession } from './session';

const verified = { emailVerified: true };
const reasoned = (
  status: number,
  code: 'conflict' | 'insufficient_pearls',
  reason: string | null,
) => new ApiRequestError(status, code, `${code}`, {}, null, reason as never);

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function setup(
  tanks: Tank[] = [tankFixture()],
  owned: RoomId[] = [],
  storage?: ReturnType<typeof memoryStorage>,
) {
  const api = {
    species: vi.fn().mockResolvedValue([speciesFixture()]),
    tanks: vi.fn().mockResolvedValue(tanks),
    tank: vi.fn(),
    wallet: vi.fn().mockResolvedValue({ balance: 2000, owned: [] }),
    ownedRooms: vi.fn().mockResolvedValue(owned),
    saveRoom: vi.fn(),
    purchase: vi.fn(),
  };
  const rec = recordBus();
  const session = new TankSession({
    api: api as unknown as ApiClient,
    interaction: rec.bus,
    sleep: async () => undefined,
    now: () => Date.parse('2026-02-01T12:00:00.000Z'),
    newKey: (() => {
      let n = 0;
      return () => `key-${++n}`;
    })(),
    ...(storage ? { storage } : {}),
  });
  return { api, rec, session };
}

const bought = (balance: number) => ({ wallet: { balance }, entry: {}, replayed: false });

async function ready(...args: Parameters<typeof setup>) {
  const made = setup(...args);
  await made.session.setUser(verified);
  await vi.waitFor(() => expect(made.api.ownedRooms).toHaveBeenCalled());
  await made.session.refreshRooms();
  return made;
}

describe('which rooms the account owns', () => {
  it('reads the paid rooms after loading', async () => {
    const { session } = await ready(undefined, ['room-zen']);
    expect(session.getState().ownedRooms).toEqual(['room-zen']);
  });

  it('keeps the last list when the read fails', async () => {
    const { session, api } = await ready(undefined, ['room-zen']);
    api.ownedRooms.mockRejectedValueOnce(new ApiRequestError(0, 'network', 'offline'));
    await session.refreshRooms();
    expect(session.getState().ownedRooms).toEqual(['room-zen']);
  });

  it('announces the tank room on load', async () => {
    const { rec } = await ready([tankFixture({ roomId: 'room-office' })], ['room-office']);
    expect(rec.of('tank:loaded')).toMatchObject([{ tankId: TANK_A, roomId: 'room-office' }]);
  });
});

describe('buying a room', () => {
  it('charges once through the account purchase, without a tank, and unlocks the room', async () => {
    const { session, api } = await ready();
    api.purchase.mockResolvedValue(bought(1000));
    api.wallet.mockResolvedValue({ balance: 1000, owned: [] });
    expect(await session.buyRoom('room-zen')).toBe(true);
    expect(api.purchase).toHaveBeenCalledTimes(1);
    expect(api.purchase).toHaveBeenCalledWith({
      itemRef: 'room:room-zen',
      idempotencyKey: 'key-1',
    });
    expect(session.getState()).toMatchObject({ balance: 1000, ownedRooms: ['room-zen'] });
  });

  it('does not charge for a free room or one already owned', async () => {
    const { session, api } = await ready(undefined, ['room-zen']);
    expect(await session.buyRoom('room-bedroom')).toBe(true);
    expect(await session.buyRoom('room-zen')).toBe(true);
    expect(api.purchase).not.toHaveBeenCalled();
  });

  it('sends one request for a double click', async () => {
    const { session, api } = await ready();
    let finish: (v: ReturnType<typeof bought>) => void = () => undefined;
    api.purchase.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = session.buyRoom('room-zen');
    const second = await session.buyRoom('room-zen');
    expect(second).toBe(false);
    finish(bought(1000));
    expect(await first).toBe(true);
    expect(api.purchase).toHaveBeenCalledTimes(1);
  });

  it('retries a lost answer under the same key so the server cannot charge twice', async () => {
    const { session, api } = await ready();
    api.purchase
      .mockRejectedValueOnce(new ApiRequestError(0, 'network', 'offline'))
      .mockResolvedValueOnce({ ...bought(1000), replayed: true });
    expect(await session.buyRoom('room-zen')).toBe(false);
    expect(await session.buyRoom('room-zen')).toBe(true);
    const keys = api.purchase.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('refuses an overdraft and says so for the shortfall note', async () => {
    const { session, api } = await ready();
    api.purchase.mockRejectedValue(reasoned(402, 'insufficient_pearls', null));
    expect(await session.buyRoom('room-submarine')).toBe(false);
    expect(session.getState()).toMatchObject({ pearlsRefused: true, ownedRooms: [] });
  });

  it('treats room_already_owned from the server as owned and charges nothing', async () => {
    const { session, api } = await ready();
    api.purchase.mockRejectedValue(reasoned(409, 'conflict', 'room_already_owned'));
    expect(await session.buyRoom('room-zen')).toBe(false);
    expect(session.getState().ownedRooms).toEqual(['room-zen']);
    expect(session.getState().balance).toBe(2000);
  });
});

describe('setting the room of a tank', () => {
  it('saves a free room and tells the scene', async () => {
    const { session, api, rec } = await ready();
    api.saveRoom.mockResolvedValue(tankFixture({ roomId: 'room-bedroom', roomSetAt: 'now' }));
    expect(await session.setRoom('room-bedroom')).toBe(true);
    expect(api.saveRoom).toHaveBeenCalledWith(TANK_A, 'room-bedroom');
    expect(rec.of('tank:room')).toEqual([{ tankId: TANK_A, roomId: 'room-bedroom' }]);
  });

  it('saves null for no room', async () => {
    const { session, api, rec } = await ready();
    api.saveRoom.mockResolvedValue(tankFixture({ roomId: null }));
    expect(await session.setRoom(null)).toBe(true);
    expect(rec.of('tank:room')).toEqual([{ tankId: TANK_A, roomId: null }]);
  });

  it('refuses a paid room that is not owned without calling the server', async () => {
    const { session, api, rec } = await ready();
    expect(await session.setRoom('room-zen')).toBe(false);
    expect(api.saveRoom).not.toHaveBeenCalled();
    expect(session.getState().error).toMatch(/not unlocked/i);
    expect(rec.of('tank:room')).toEqual([]);
  });

  it('allows an owned paid room', async () => {
    const { session, api } = await ready(undefined, ['room-zen']);
    api.saveRoom.mockResolvedValue(tankFixture({ roomId: 'room-zen' }));
    expect(await session.setRoom('room-zen')).toBe(true);
  });

  it('refuses an unknown room id', async () => {
    const { session, api } = await ready();
    expect(await session.setRoom('room-nope' as RoomId)).toBe(false);
    expect(api.saveRoom).not.toHaveBeenCalled();
    expect(session.getState().error).toMatch(/does not exist/i);
  });

  it('does not call the server for the room the tank already has', async () => {
    const { session, api } = await ready();
    expect(await session.setRoom('room-living')).toBe(true);
    expect(api.saveRoom).not.toHaveBeenCalled();
  });

  it('keeps the shown room and refreshes ownership when the server says it is not owned', async () => {
    const { session, api, rec } = await ready(undefined, ['room-zen']);
    api.saveRoom.mockRejectedValue(reasoned(409, 'conflict', 'room_not_owned'));
    api.ownedRooms.mockResolvedValue([]);
    expect(await session.setRoom('room-zen')).toBe(false);
    await vi.waitFor(() => expect(session.getState().ownedRooms).toEqual([]));
    expect(rec.of('tank:room')).toEqual([]);
  });
});

describe('the device room from before rooms', () => {
  it('moves an unset tank into the owned office once, then forgets the key', async () => {
    const storage = memoryStorage({ 'aquarium.room': 'office' });
    const { session, api } = setup([tankFixture()], ['room-office'], storage);
    api.saveRoom.mockResolvedValue(tankFixture({ roomId: 'room-office', roomSetAt: 'now' }));
    await session.setUser(verified);
    await vi.waitFor(() => expect(storage.store.has('aquarium.room')).toBe(false));
    expect(api.saveRoom).toHaveBeenCalledTimes(1);
    expect(api.saveRoom).toHaveBeenCalledWith(TANK_A, 'room-office');
  });

  it('keeps the key and does not migrate while the owned rooms cannot be read, then migrates', async () => {
    const storage = memoryStorage({ 'aquarium.room': 'office' });
    const { session, api } = setup([tankFixture()], ['room-office'], storage);
    api.ownedRooms.mockRejectedValueOnce(new ApiRequestError(0, 'network', 'offline'));
    api.saveRoom.mockResolvedValue(tankFixture({ roomId: 'room-office', roomSetAt: 'now' }));
    await session.setUser(verified);
    await vi.waitFor(() => expect(api.ownedRooms).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(storage.store.get('aquarium.room')).toBe('office');
    expect(api.saveRoom).not.toHaveBeenCalled();
    await session.refreshRooms();
    expect(api.saveRoom).toHaveBeenCalledWith(TANK_A, 'room-office');
    expect(storage.store.has('aquarium.room')).toBe(false);
  });

  it('keeps the key when the save fails so the next load retries', async () => {
    const storage = memoryStorage({ 'aquarium.room': 'none' });
    const { session, api } = setup([tankFixture()], [], storage);
    api.saveRoom.mockRejectedValue(new ApiRequestError(0, 'network', 'offline'));
    await session.setUser(verified);
    await vi.waitFor(() => expect(api.saveRoom).toHaveBeenCalled());
    await session.refreshRooms();
    expect(storage.store.get('aquarium.room')).toBe('none');
  });

  it('leaves a tank alone that the player already set', async () => {
    const storage = memoryStorage({ 'aquarium.room': 'none' });
    const { session, api } = setup(
      [tankFixture({ roomId: 'room-living', roomSetAt: '2026-02-01T10:00:00.000Z' })],
      [],
      storage,
    );
    await session.setUser(verified);
    await vi.waitFor(() => expect(storage.store.has('aquarium.room')).toBe(false));
    expect(api.saveRoom).not.toHaveBeenCalled();
  });
});
