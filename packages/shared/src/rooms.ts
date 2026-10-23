import { z } from 'zod';
import { authIdSchema, slugSchema, timestampSchema } from './common.js';

// content/rooms.json lists the same ids and content/economy.json prices them; rooms.test.ts keeps
// all three in step. Ids name slots and stay fixed. Removing an id needs a migration that resets
// tanks.room_id to 'room-living' on the rows that chose it and deletes it from owned_rooms.
export const FREE_ROOM_IDS = ['room-living', 'room-bedroom'] as const;

export const PAID_ROOM_IDS = [
  'room-shop',
  'room-office',
  'room-loft',
  'room-zen',
  'room-beach',
  'room-cabin',
  'room-sushi',
  'room-library',
  'room-public-aquarium',
  'room-submarine',
] as const;

export const ROOM_IDS = [...FREE_ROOM_IDS, ...PAID_ROOM_IDS] as const;

export const roomIdSchema = z.enum(ROOM_IDS);
export type RoomId = z.infer<typeof roomIdSchema>;

export const DEFAULT_ROOM_ID: RoomId = 'room-living';

export const ROOM_PRICE_MIN = 500;
export const ROOM_PRICE_MAX = 1500;

export function isFreeRoom(id: RoomId): boolean {
  return (FREE_ROOM_IDS as readonly string[]).includes(id);
}

export function roomRef(id: RoomId): string {
  return `room:${id}`;
}

const assetPath = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.[a-z0-9]+$/, 'must be a relative file path')
  .refine((f) => !f.includes('..'), 'must not climb out of its directory');

const hexColour = z.string().regex(/^#[0-9a-f]{6}$/, 'must be a lowercase #rrggbb colour');

// Licence and credit live in assets/manifest.json; each ref names a manifest entry. T74 fills the
// refs in, so every one may be null or empty until the room is sourced.
export const roomAssetsSchema = z.strictObject({
  shell: slugSchema.nullable().describe('low-poly room shell'),
  furniture: z.array(slugSchema).describe('instanced glTF furniture and props'),
  hdri: slugSchema.nullable().describe('1k HDRI for reflections and the PMREM'),
});
export type RoomAssets = z.infer<typeof roomAssetsSchema>;

export const roomEntrySchema = z.strictObject({
  id: roomIdSchema,
  name: z.string().trim().min(1).max(40),
  assets: roomAssetsSchema,
  ambience: z
    .strictObject({
      sound: assetPath.nullable().describe('looping ambience file, null for silence'),
      asset: slugSchema.nullable(),
    })
    .refine((a) => a.sound === null || a.asset !== null, {
      message: 'an ambience with a sound needs its manifest asset id',
      path: ['asset'],
    }),
  hasWindow: z.boolean(),
});
export type RoomEntry = z.infer<typeof roomEntrySchema>;

export const roomLightRigSchema = z.strictObject({
  keyColor: hexColour.describe('colour of the main light'),
  keyIntensity: z.number().min(0).max(10),
  ambientColor: hexColour,
  ambientIntensity: z.number().min(0).max(2),
  windowPosition: z
    .tuple([z.number(), z.number(), z.number()])
    .nullable()
    .describe(
      'where daylight enters, in metres from the tank centre; null when the room has no window',
    ),
});
export type RoomLightRig = z.infer<typeof roomLightRigSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const roomPropSchema = z.strictObject({
  asset: slugSchema.describe('a furniture or prop entry of the room in content/rooms.json'),
  position: vec3.describe('metres from the tank centre'),
  rotationY: z.number().describe('radians'),
  scale: z.number().positive().default(1),
});
export type RoomProp = z.infer<typeof roomPropSchema>;

// content/presets/rooms/<roomId>.json belongs to scene-builder. Every room has one; rooms.test.ts
// fails when a file is missing. T76 fills in the layouts.
export const roomPresetSchema = z.strictObject({
  roomId: roomIdSchema,
  layout: z.array(roomPropSchema),
  light: roomLightRigSchema,
});
export type RoomPreset = z.infer<typeof roomPresetSchema>;

export const roomFileSchema = z.array(roomEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((e, index) => {
    if (seen.has(e.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate id "${e.id}"`, path: [index, 'id'] });
    }
    seen.add(e.id);
  });
});

const priceShape = {
  'room-living': z.int().min(0),
  'room-bedroom': z.int().min(0),
  'room-shop': z.int().min(0),
  'room-office': z.int().min(0),
  'room-loft': z.int().min(0),
  'room-zen': z.int().min(0),
  'room-beach': z.int().min(0),
  'room-cabin': z.int().min(0),
  'room-sushi': z.int().min(0),
  'room-library': z.int().min(0),
  'room-public-aquarium': z.int().min(0),
  'room-submarine': z.int().min(0),
} satisfies Record<RoomId, z.ZodType<number>>;

export const roomPricesSchema = z.strictObject(priceShape).superRefine((prices, ctx) => {
  for (const id of ROOM_IDS) {
    const price = prices[id];
    if (isFreeRoom(id)) {
      if (price !== 0) {
        ctx.addIssue({ code: 'custom', message: 'a free room costs 0', path: [id] });
      }
    } else if (price < ROOM_PRICE_MIN || price > ROOM_PRICE_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `a paid room costs ${ROOM_PRICE_MIN} to ${ROOM_PRICE_MAX} Pearls`,
        path: [id],
      });
    }
  }
});

export const ownedRoomSchema = z.strictObject({
  userId: authIdSchema,
  roomId: roomIdSchema,
  purchasedAt: timestampSchema,
});
export type OwnedRoom = z.infer<typeof ownedRoomSchema>;

export const ownedRoomsResponseSchema = z.strictObject({
  owned: z
    .array(roomIdSchema)
    .describe(
      'the paid rooms the account bought, one purchase unlocking the room for all its tanks; the free rooms are always usable and never listed',
    ),
});
export type OwnedRoomsResponse = z.infer<typeof ownedRoomsResponseSchema>;
