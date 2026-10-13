import { addFishRequestSchema, createTankRequestSchema, type Biome } from '@aquarium/shared';

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

function check(
  schema: { safeParse(v: unknown): { success: true; data: string } | { success: false } },
  name: string,
  label: string,
): NameCheck {
  const parsed = schema.safeParse(name);
  if (parsed.success) return { ok: true, name: parsed.data };
  return {
    ok: false,
    message:
      name.trim().length === 0 ? `Give the ${label} a name.` : `That ${label} name is too long.`,
  };
}

export const checkFishName = (name: string): NameCheck =>
  check(addFishRequestSchema.shape.name, name, 'fish');
export const checkTankName = (name: string): NameCheck =>
  check(createTankRequestSchema.shape.name, name, 'tank');

const FISH_NAMES = [
  'Pip',
  'Bubbles',
  'Marlow',
  'Coral',
  'Finn',
  'Dot',
  'Nemo',
  'Sprout',
  'Misty',
  'Ripple',
  'Pebble',
  'Comet',
  'Juniper',
  'Skye',
  'Tango',
  'Olive',
  'Ziggy',
  'Wren',
  'Maple',
  'Echo',
];

export function suggestFishName(taken: readonly string[], seed = 0): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 0; i < FISH_NAMES.length; i++) {
    const name = FISH_NAMES[(seed + i) % FISH_NAMES.length] ?? 'Pip';
    if (!used.has(name.toLowerCase())) return name;
  }
  return `Fish ${taken.length + 1}`;
}

export function suggestTankName(biome: Biome, taken: readonly string[]): string {
  const base = biome === 'reef' ? 'Reef tank' : 'Freshwater tank';
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }
  return base;
}
