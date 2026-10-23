import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { economySchema, ledgerEntrySchema } from './economy.js';
import { conflictReasonSchema } from './errors.js';
import {
  FREE_ROOM_IDS,
  PAID_ROOM_IDS,
  ROOM_IDS,
  ROOM_PRICE_MAX,
  ROOM_PRICE_MIN,
  roomEntrySchema,
  roomFileSchema,
  roomIdSchema,
  roomLightRigSchema,
  roomPresetSchema,
  roomPricesSchema,
  ownedRoomsResponseSchema,
} from './rooms.js';
import { updateTankRequestSchema } from './tank.js';

const content = join(import.meta.dirname, '../../../content');
const readJson = (file: string): unknown => JSON.parse(readFileSync(join(content, file), 'utf8'));

describe('room ids', () => {
  it('has 12 distinct ids, two of them free', () => {
    expect(new Set(ROOM_IDS).size).toBe(12);
    expect(FREE_ROOM_IDS).toEqual(['room-living', 'room-bedroom']);
    expect(PAID_ROOM_IDS).toHaveLength(10);
  });

  it('rejects an unknown id', () => {
    expect(roomIdSchema.safeParse('room-attic').success).toBe(false);
    expect(roomIdSchema.safeParse('').success).toBe(false);
    expect(roomIdSchema.safeParse(null).success).toBe(false);
  });

  it('is accepted by the tank PATCH, null means no room and an unknown id is not', () => {
    expect(updateTankRequestSchema.safeParse({ roomId: 'room-zen' }).success).toBe(true);
    expect(updateTankRequestSchema.safeParse({ roomId: 'room-attic' }).success).toBe(false);
    expect(updateTankRequestSchema.safeParse({ roomId: null }).success).toBe(true);
  });

  it('has a 409 reason for a room the account does not own', () => {
    expect(conflictReasonSchema.safeParse('room_not_owned').success).toBe(true);
    expect(conflictReasonSchema.safeParse('room_already_owned').success).toBe(true);
  });
});

describe('content/rooms.json', () => {
  const rooms = roomFileSchema.parse(readJson('rooms.json'));

  it('keeps the window T57 gave the living room', () => {
    expect(rooms.find((r) => r.id === 'room-living')?.hasWindow).toBe(true);
  });

  it('lists every room id once, in order', () => {
    expect(rooms.map((r) => r.id)).toEqual([...ROOM_IDS]);
  });

  it('gives every room a distinct name', () => {
    expect(new Set(rooms.map((r) => r.name)).size).toBe(rooms.length);
  });

  it('rejects a duplicate id and a sound without a manifest asset', () => {
    const [first] = rooms;
    if (first === undefined) throw new Error('rooms.json is empty');
    expect(roomFileSchema.safeParse([first, first]).success).toBe(false);
    expect(
      roomEntrySchema.safeParse({ ...first, ambience: { sound: 'room/hum.ogg', asset: null } })
        .success,
    ).toBe(false);
    expect(roomEntrySchema.safeParse({ ...first, extra: 1 }).success).toBe(false);
    expect(
      roomEntrySchema.safeParse({ ...first, swatch: { key: 'red', ambient: '#000000' } }).success,
    ).toBe(false);
  });
});

describe('content/presets/rooms', () => {
  const rooms = roomFileSchema.parse(readJson('rooms.json'));

  it('has a valid preset for every room, named after it, with a window position only where the room has a window', () => {
    for (const room of rooms) {
      const file = `presets/rooms/${room.id}.json`;
      expect(existsSync(join(content, file)), file).toBe(true);
      const preset = roomPresetSchema.parse(readJson(file));
      expect(preset.roomId).toBe(room.id);
      expect(preset.light.windowPosition !== null, room.id).toBe(room.hasWindow);
      expect(room.swatch, room.id).toEqual({
        key: preset.light.keyColor,
        ambient: preset.light.ambientColor,
      });
      if (preset.light.windowPosition !== null) {
        expect(preset.light.windowPosition[0], `${room.id} window side`).toBeGreaterThan(0);
      }
    }
  });

  it('rejects a bad colour, a negative intensity and a prop with an unknown field', () => {
    const rig = {
      keyColor: '#ffffff',
      keyIntensity: 1,
      ambientColor: '#000000',
      ambientIntensity: 0.5,
      windowPosition: null,
    };
    expect(roomLightRigSchema.safeParse(rig).success).toBe(true);
    expect(roomLightRigSchema.safeParse({ ...rig, keyColor: 'white' }).success).toBe(false);
    expect(roomLightRigSchema.safeParse({ ...rig, keyIntensity: -1 }).success).toBe(false);
    const prop = { asset: 'sofa', position: [0, 0, 1], rotationY: 0 };
    expect(
      roomPresetSchema.safeParse({ roomId: 'room-zen', layout: [prop], light: rig }).success,
    ).toBe(true);
    expect(
      roomPresetSchema.safeParse({
        roomId: 'room-zen',
        layout: [{ ...prop, x: 1 }],
        light: rig,
      }).success,
    ).toBe(false);
  });
});

describe('room prices in content/economy.json', () => {
  const economy = economySchema.parse(readJson('economy.json'));

  it('prices exactly the room ids', () => {
    expect(Object.keys(economy.rooms).sort()).toEqual([...ROOM_IDS].sort());
  });

  it('keeps the free rooms at 0 and every paid room within 500 to 1500', () => {
    for (const id of FREE_ROOM_IDS) expect(economy.rooms[id]).toBe(0);
    for (const id of PAID_ROOM_IDS) {
      expect(economy.rooms[id]).toBeGreaterThanOrEqual(ROOM_PRICE_MIN);
      expect(economy.rooms[id]).toBeLessThanOrEqual(ROOM_PRICE_MAX);
    }
  });

  it('refuses a priced free room, a cheap or dear paid room and a missing room', () => {
    const valid = { ...economy.rooms };
    expect(roomPricesSchema.safeParse(valid).success).toBe(true);
    expect(roomPricesSchema.safeParse({ ...valid, 'room-living': 100 }).success).toBe(false);
    expect(roomPricesSchema.safeParse({ ...valid, 'room-shop': 0 }).success).toBe(false);
    expect(roomPricesSchema.safeParse({ ...valid, 'room-shop': 499 }).success).toBe(false);
    expect(roomPricesSchema.safeParse({ ...valid, 'room-submarine': 1501 }).success).toBe(false);
    expect(roomPricesSchema.safeParse({ ...valid, 'room-shop': 600.5 }).success).toBe(false);
    const missing: Record<string, number> = { ...valid };
    delete missing['room-shop'];
    expect(roomPricesSchema.safeParse(missing).success).toBe(false);
  });
});

describe('owned rooms response', () => {
  it('lists room ids and nothing else', () => {
    expect(ownedRoomsResponseSchema.safeParse({ owned: ['room-zen'] }).success).toBe(true);
    expect(ownedRoomsResponseSchema.safeParse({ owned: ['room-attic'] }).success).toBe(false);
    expect(ownedRoomsResponseSchema.safeParse({ owned: [], extra: 1 }).success).toBe(false);
  });
});

describe('zero-Pearl grant', () => {
  const entry = {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    userId: 'user1',
    delta: 0,
    reason: 'grant',
    source: 'game',
    itemRef: 'room:room-office',
    idempotencyKey: 'room-office-grant-user1',
    createdAt: '2026-10-23T00:00:00.000Z',
  };

  it('lets a grant move 0 Pearls and nothing else', () => {
    expect(ledgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(ledgerEntrySchema.safeParse({ ...entry, reason: 'purchase' }).success).toBe(false);
  });
});
