import { describe, expect, it } from 'vitest';
import { planRoomMigration } from './roomMigration';

const fresh = (id: string) => ({ id, roomId: 'room-living' as const, roomSetAt: null });

describe('planRoomMigration', () => {
  it('does nothing and keeps nothing to clear when the key is absent', () => {
    expect(planRoomMigration(null, [fresh('a')], [])).toEqual({ moves: [], done: false });
  });

  it('moves every unset living-room tank into the owned office', () => {
    expect(planRoomMigration('office', [fresh('a'), fresh('b')], ['room-office'])).toEqual({
      moves: [
        { tankId: 'a', roomId: 'room-office' },
        { tankId: 'b', roomId: 'room-office' },
      ],
      done: true,
    });
  });

  it('maps none to the plain studio', () => {
    expect(planRoomMigration('none', [fresh('a')], []).moves).toEqual([
      { tankId: 'a', roomId: null },
    ]);
  });

  it('leaves tanks the player set, and tanks already in another room', () => {
    const set = { id: 'a', roomId: 'room-living' as const, roomSetAt: '2026-10-23T10:00:00.000Z' };
    const moved = { id: 'b', roomId: 'room-zen' as const, roomSetAt: null };
    expect(planRoomMigration('none', [set, moved], []).moves).toEqual([]);
  });

  it('does not apply the office to an owner who does not have it, but still finishes', () => {
    expect(planRoomMigration('office', [fresh('a')], [])).toEqual({ moves: [], done: true });
  });

  it('needs no move for the living room, which is already the default', () => {
    expect(planRoomMigration('living-room', [fresh('a')], [])).toEqual({ moves: [], done: true });
  });

  it('drops a value T57 never wrote', () => {
    expect(planRoomMigration('basement', [fresh('a')], [])).toEqual({ moves: [], done: true });
    expect(planRoomMigration('toString', [fresh('a')], [])).toEqual({ moves: [], done: true });
  });
});
