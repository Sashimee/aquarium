import { describe, expect, it, vi } from 'vitest';
import { RoomPreference, ROOM_STORAGE_KEY, type RoomStorage } from './preference';

function memory(initial?: string): RoomStorage & { value: string | null } {
  const store = { value: initial ?? null } as RoomStorage & { value: string | null };
  store.getItem = () => store.value;
  store.setItem = (_key, value) => {
    store.value = value;
  };
  return store;
}

describe('RoomPreference', () => {
  it('starts with no room when nothing is stored', () => {
    expect(new RoomPreference(memory()).snapshot()).toBe('none');
    expect(new RoomPreference(null).snapshot()).toBe('none');
  });

  it('reads a stored choice', () => {
    expect(new RoomPreference(memory('office')).snapshot()).toBe('office');
  });

  it('ignores a stored value that is not a choice', () => {
    expect(new RoomPreference(memory('garage')).snapshot()).toBe('none');
  });

  it('falls back when storage throws on read', () => {
    const storage: RoomStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(new RoomPreference(storage).snapshot()).toBe('none');
  });

  it('stores a change under its key and tells subscribers once', () => {
    const storage = memory();
    const spy = vi.spyOn(storage, 'setItem');
    const preference = new RoomPreference(storage);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.set('living-room');
    preference.set('living-room');
    expect(preference.snapshot()).toBe('living-room');
    expect(spy).toHaveBeenCalledExactlyOnceWith(ROOM_STORAGE_KEY, 'living-room');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps the choice for the session when storage refuses the write', () => {
    const preference = new RoomPreference({
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    });
    preference.set('office');
    expect(preference.snapshot()).toBe('office');
  });

  it('rejects an unknown choice and stops telling an unsubscribed listener', () => {
    const preference = new RoomPreference(null);
    const listener = vi.fn();
    const off = preference.subscribe(listener);
    expect(() => preference.set('garage' as never)).toThrow(/Unknown room choice/);
    off();
    preference.set('office');
    expect(listener).not.toHaveBeenCalled();
  });
});
