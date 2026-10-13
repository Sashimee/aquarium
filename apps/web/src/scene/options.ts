import { biomeSchema, type Biome } from '@aquarium/shared';

export interface SceneOptions {
  /** `?colliders=1` shows the collider wireframes. */
  colliders: boolean;
}

export function parseSceneOptions(search: string): SceneOptions {
  const params = new URLSearchParams(search);
  const colliders = params.get('colliders');
  if (colliders !== null && colliders !== '0' && colliders !== '1') {
    console.warn(`Ignoring ?colliders=${colliders}; use 0 or 1`);
    return { colliders: false };
  }
  return { colliders: colliders === '1' };
}

/** The query string with `?biome=` set to `biome`, every other parameter kept. */
export function withBiome(search: string, biome: Biome): string {
  const params = new URLSearchParams(search);
  params.set('biome', biome);
  return `?${params.toString()}`;
}

/** `?biome=reef` picks the preset; anything else, including a typo, falls back to freshwater. */
export function parseBiome(search: string): Biome {
  const value = new URLSearchParams(search).get('biome');
  if (value === null) return 'freshwater';
  const parsed = biomeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(`Ignoring ?biome=${value}; use freshwater or reef`);
  return 'freshwater';
}
