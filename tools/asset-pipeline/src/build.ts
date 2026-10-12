import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readyCodecs } from './glb.ts';
import { buildSourceFish, type FishContext } from './fish.ts';
import { buildAnemone } from './anemone.ts';
import { buildEnvironment, buildHdri, buildSubstrate } from './environment.ts';
import { LOFT_FISH_RECIPES, buildLoftFish } from './loft-fish.ts';
import {
  CUSTOM_ATTRIBUTES_NOTE,
  TEXTURE_VARIANTS_NOTE,
  assetIndexSchema,
  type AssetIndex,
  type OutputAsset,
} from './index-schema.ts';
import { aggregateSha256, manifestSchema } from './manifest.ts';
import { verifyRawSource } from './source.ts';
import { ENVIRONMENT_RECIPES, FISH_RECIPES, HDRI_RECIPES, SUBSTRATE_RECIPES } from './recipes.ts';

export interface BuildOptions {
  repoRoot: string;
  only: string[];
}

interface Task {
  kind: OutputAsset['kind'];
  id: string;
  run(ctx: FishContext): Promise<OutputAsset>;
}

const KIND_ORDER: OutputAsset['kind'][] = [
  'fish',
  'anemone',
  'plant',
  'coral',
  'driftwood',
  'rock',
  'decor',
  'substrate',
  'hdri',
];

function tasks(): Task[] {
  return [
    ...FISH_RECIPES.map((recipe) => ({
      kind: 'fish' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildSourceFish(recipe, ctx),
    })),
    { kind: 'anemone' as const, id: 'host-anemone', run: (ctx: FishContext) => buildAnemone(ctx) },
    ...ENVIRONMENT_RECIPES.map((recipe) => ({
      kind: recipe.kind,
      id: recipe.id,
      run: (ctx: FishContext) => buildEnvironment(recipe, ctx),
    })),
    ...SUBSTRATE_RECIPES.map((recipe) => ({
      kind: 'substrate' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildSubstrate(recipe, ctx),
    })),
    ...HDRI_RECIPES.map((recipe) => ({
      kind: 'hdri' as const,
      id: recipe.id,
      run: (ctx: FishContext) => Promise.resolve(buildHdri(recipe, ctx)),
    })),
    ...LOFT_FISH_RECIPES.map((recipe) => ({
      kind: 'fish' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildLoftFish(recipe, ctx),
    })),
  ];
}

export async function build(options: BuildOptions): Promise<void> {
  const { repoRoot, only } = options;
  const outRoot = join(repoRoot, 'apps', 'web', 'public', 'assets');
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'manifest.json'), 'utf8')),
  );
  const licences = new Map(manifest.assets.map((a) => [a.id, a.licence]));
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const verified = new Set<string>();
  const ctx: FishContext = {
    repoRoot,
    outRoot,
    verifySource: (sourceId) => {
      if (verified.has(sourceId)) return;
      const source = byId.get(sourceId);
      if (!source) throw new Error(`${sourceId} is not in assets/manifest.json`);
      verifyRawSource(source, aggregateSha256);
      verified.add(sourceId);
    },
    licenceOf: (sourceId) => {
      const licence = licences.get(sourceId);
      if (!licence) throw new Error(`${sourceId} is not in assets/manifest.json`);
      return licence;
    },
  };

  const indexPath = join(outRoot, 'index.json');
  const previous = new Map<string, OutputAsset>();
  if (existsSync(indexPath)) {
    for (const asset of assetIndexSchema.parse(JSON.parse(readFileSync(indexPath, 'utf8')))
      .assets) {
      previous.set(`${asset.kind}/${asset.id}`, asset);
    }
  }

  await readyCodecs();
  const selected = tasks().filter((t) => only.length === 0 || only.includes(t.id));
  if (only.length > 0 && selected.length !== only.length) {
    const known = tasks().map((t) => t.id);
    throw new Error(`unknown asset id in [${only.join(', ')}]; known: ${known.join(', ')}`);
  }
  for (const task of selected) {
    const started = Date.now();
    rmSync(join(outRoot, task.kind, task.id), { recursive: true, force: true });
    const asset = await task.run(ctx);
    previous.set(`${task.kind}/${task.id}`, asset);
    const bytes = asset.files.reduce((s, f) => s + f.bytes, 0);
    console.log(
      `${task.kind}/${task.id}: ${(bytes / 1e6).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }

  const assets = [...previous.values()].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    return ka !== kb ? ka - kb : a.id < b.id ? -1 : 1;
  });
  const index: AssetIndex = {
    version: 1,
    textureVariants: TEXTURE_VARIANTS_NOTE,
    customAttributes: CUSTOM_ATTRIBUTES_NOTE,
    totalBytes: assets.reduce((s, a) => s + a.files.reduce((t, f) => t + f.bytes, 0), 0),
    assets,
  };
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify(assetIndexSchema.parse(index), null, 2)}\n`);
  console.log(`index.json: ${assets.length} assets, ${(index.totalBytes / 1e6).toFixed(1)} MB`);
}
