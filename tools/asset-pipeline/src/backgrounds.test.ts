import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backgroundFileSchema, playableBiomeSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LICENCES } from './manifest.ts';

const root = join(import.meta.dirname, '../../..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'));

interface ManifestAsset {
  id: string;
  kind: string;
  biome?: string;
  licence: string;
}
const manifest = readJson('assets/manifest.json') as { assets: ManifestAsset[] };

describe('content/backgrounds against assets/manifest.json', () => {
  it('names each background by its own manifest entry, once, in its biome, under an allowed licence', () => {
    const used = new Set<string>();
    for (const biome of playableBiomeSchema.options) {
      const entries = backgroundFileSchema.parse(readJson(`content/backgrounds/${biome}.json`));
      for (const entry of entries) {
        if (entry.asset === null) continue;
        expect(entry.asset, `${entry.id}: asset must equal the slot id`).toBe(entry.id);
        expect(used.has(entry.asset), `${entry.asset} is used twice`).toBe(false);
        used.add(entry.asset);

        const asset = manifest.assets.find((a) => a.id === entry.asset);
        expect(asset, `${entry.id}: "${entry.asset}" is not in assets/manifest.json`).toBeDefined();
        expect(asset?.kind, entry.id).toBe('background');
        expect(asset?.biome, `${entry.id}: manifest biome differs from its content file`).toBe(
          biome,
        );
        expect(ALLOWED_LICENCES as readonly string[], `${entry.id}: ${asset?.licence}`).toContain(
          asset?.licence,
        );
      }
    }
    expect(used.size).toBeGreaterThan(0);
  });
});
