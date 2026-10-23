import { ROOM_IDS } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { NO_ROOM_TITLE, ROOM_ENTRIES, roomAmbienceAsset, roomTitle } from './roomCatalog';

describe('the room catalog', () => {
  it('lists every room id once', () => {
    expect(ROOM_ENTRIES.map((e) => e.id).sort()).toEqual([...ROOM_IDS].sort());
  });

  it('names rooms and the lack of one', () => {
    expect(roomTitle('room-office')).toBe('Home office');
    expect(roomTitle(null)).toBe(NO_ROOM_TITLE);
  });

  it('finds the ambience asset of a room', () => {
    expect(roomAmbienceAsset('room-living')).toBe('freesound-329533');
  });

  it('plays nothing for no room', () => {
    expect(roomAmbienceAsset(null)).toBeNull();
  });
});
