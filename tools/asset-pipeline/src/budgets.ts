import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AssetIndex, OutputAsset } from './index-schema.ts';

/** PLAN section 2.7: initial download. */
export const TIER_BUDGETS = {
  mobile: { tiers: 'low/medium', slot: '1k', bytes: 15 * 1000 * 1000 },
  desktop: { tiers: 'high/ultra', slot: '2k', bytes: 40 * 1000 * 1000 },
} as const;

export type BudgetGroup = keyof typeof TIER_BUDGETS;

/** Brotli JS plus the Basis transcoder, which the asset files do not include. */
export const CODE_RESERVE_BYTES = 1.5 * 1000 * 1000;

/** The environment map `Engine` fetches on every tier. */
export const DEFAULT_HDRI_ID = 'studio-small-09';

export interface PresetRef {
  id: string;
  biome: string;
  assetIds: string[];
}

export interface BudgetInput {
  index: AssetIndex;
  presets: PresetRef[];
  speciesBiome: ReadonlyMap<string, string>;
}

const presetSchema = z.object({
  id: z.string(),
  biome: z.string(),
  substrate: z.object({ assetId: z.string() }),
  decor: z.array(z.object({ assetId: z.string() })),
  plantPatches: z.array(z.object({ assetId: z.string() })),
});

const speciesSchema = z.object({ id: z.string(), biome: z.string() });

function readJsonDir<T>(dir: string, schema: z.ZodType<T>): T[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => schema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
}

export function loadBudgetContent(repoRoot: string): Pick<BudgetInput, 'presets' | 'speciesBiome'> {
  const presets = readJsonDir(join(repoRoot, 'content', 'presets'), presetSchema).map((p) => ({
    id: p.id,
    biome: p.biome,
    assetIds: [
      ...new Set([
        p.substrate.assetId,
        ...p.decor.map((d) => d.assetId),
        ...p.plantPatches.map((d) => d.assetId),
      ]),
    ],
  }));
  const speciesBiome = new Map(
    readJsonDir(join(repoRoot, 'content', 'species'), speciesSchema).map((s) => [s.id, s.biome]),
  );
  return { presets, speciesBiome };
}

function filesToFetch(asset: OutputAsset, slots: readonly ('1k' | '2k')[]): Map<string, number> {
  const sizeOf = new Map(asset.files.map((f) => [f.file, f.bytes]));
  const wanted = new Map<string, number>();
  const add = (file: string): void => {
    const bytes = sizeOf.get(file);
    if (bytes === undefined)
      throw new Error(`${asset.kind}/${asset.id}: ${file} is not in files[]`);
    wanted.set(file, bytes);
  };
  // Fish swap LOD with distance, so all of them can be fetched; everything else loads one.
  for (const lod of asset.kind === 'fish' ? asset.lods : asset.lods.slice(0, 1)) add(lod.file);
  for (const texture of asset.textures) for (const slot of slots) add(texture.variants[slot].file);
  if (asset.kind === 'hdri') for (const f of asset.files) add(f.file);
  return wanted;
}

/**
 * Worst-case bytes a preset fetches before it is interactive. Desktop also counts the 1k
 * textures because hardscape collision geometry still pulls the low set (#174).
 */
export function presetDownloadBytes(
  input: BudgetInput,
  preset: PresetRef,
  group: BudgetGroup,
): number {
  const slots = group === 'desktop' ? (['1k', '2k'] as const) : (['1k'] as const);
  const byKey = new Map(input.index.assets.map((a) => [a.id, a]));
  const assets: OutputAsset[] = [];
  const hdri = byKey.get(DEFAULT_HDRI_ID);
  if (hdri) assets.push(hdri);
  for (const id of preset.assetIds) {
    const asset = byKey.get(id);
    // Procedural decor (e.g. Euphyllia) has no files to download.
    if (!asset) continue;
    assets.push(asset);
  }
  for (const asset of input.index.assets) {
    if (
      asset.kind === 'fish' &&
      asset.species &&
      input.speciesBiome.get(asset.species) === preset.biome
    )
      assets.push(asset);
  }
  const fetched = new Map<string, number>();
  for (const asset of assets)
    for (const [file, bytes] of filesToFetch(asset, slots)) fetched.set(file, bytes);
  return [...fetched.values()].reduce((sum, bytes) => sum + bytes, 0);
}

export function budgetProblems(input: BudgetInput): string[] {
  const problems: string[] = [];
  for (const group of Object.keys(TIER_BUDGETS) as BudgetGroup[]) {
    const { tiers, bytes: budget } = TIER_BUDGETS[group];
    const limit = budget - CODE_RESERVE_BYTES;
    for (const preset of input.presets) {
      let bytes: number;
      try {
        bytes = presetDownloadBytes(input, preset, group);
      } catch (error) {
        problems.push(`download budget: ${(error as Error).message}`);
        continue;
      }
      if (bytes > limit) {
        problems.push(
          `download budget: preset ${preset.id} on ${tiers} fetches ${(bytes / 1e6).toFixed(1)} MB of assets, over ${(limit / 1e6).toFixed(1)} MB (${budget / 1e6} MB budget less ${CODE_RESERVE_BYTES / 1e6} MB for code)`,
        );
      }
    }
  }
  return problems;
}
