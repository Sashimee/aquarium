import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readyCodecs } from './glb.ts';
import { contactSheet, type Atlas } from './impostor.ts';
import { buildSourceFish, type FishContext } from './fish.ts';
import { buildAnemone } from './anemone.ts';
import { SHRIMP_RECIPES, buildShrimp } from './shrimp.ts';
import { NERITE_RECIPES, buildNerite } from './nerite.ts';
import { HERMIT_RECIPES, buildHermit } from './hermit.ts';
import { buildEnvironment, buildHdri, buildSubstrate } from './environment.ts';
import { BLACKWATER_FISH_RECIPES } from './blackwater-fish.ts';
import { LEAF_CARD_RECIPES, buildLeafCard } from './leaf-card.ts';
import { LOFT_FISH_RECIPES, buildLoftFish } from './loft-fish.ts';
import {
  MANGROVE_ENVIRONMENT_RECIPES,
  MANGROVE_FISH_RECIPES,
  MANGROVE_LOFT_RECIPES,
  MANGROVE_SUBSTRATE_RECIPES,
} from './mangrove.ts';
import {
  CUSTOM_ATTRIBUTES_NOTE,
  TEXTURE_VARIANTS_NOTE,
  assetIndexSchema,
  type AssetIndex,
  type OutputAsset,
} from './index-schema.ts';
import { aggregateSha256, manifestSchema, type ManifestAsset } from './manifest.ts';
import { AUDIO_RECIPES, buildAudio } from './audio.ts';
import {
  buildBackground,
  contactSheet as backgroundSheet,
  syncContentFiles,
} from './backgrounds.ts';
import type { Rgba } from './textures.ts';
import { RAW_ROOT, verifyRawSource } from './source.ts';
import {
  ENVIRONMENT_RECIPES,
  FISH_RECIPES,
  HDRI_RECIPES,
  ROCK_PILE_RECIPES,
  SUBSTRATE_RECIPES,
} from './recipes.ts';
import { buildRockPile } from './rock-pile.ts';

export interface BuildOptions {
  repoRoot: string;
  only: string[];
  impostorSheetDir?: string;
  /** Writes a contact sheet of the built backgrounds' low tier to this PNG path. */
  backgroundSheet?: string;
}

interface Task {
  kind: OutputAsset['kind'];
  id: string;
  run(ctx: FishContext): Promise<OutputAsset>;
}

const KIND_ORDER: OutputAsset['kind'][] = [
  'fish',
  'shrimp',
  'crab',
  'snail',
  'anemone',
  'plant',
  'coral',
  'driftwood',
  'rock',
  'decor',
  'substrate',
  'hdri',
  'audio',
  'background',
];

function tasks(backgrounds: readonly ManifestAsset[], previews: Map<string, Rgba>): Task[] {
  return [
    ...FISH_RECIPES.map((recipe) => ({
      kind: 'fish' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildSourceFish(recipe, ctx),
    })),
    ...MANGROVE_FISH_RECIPES.map((recipe) => ({
      kind: 'fish' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildSourceFish(recipe, ctx),
    })),
    ...SHRIMP_RECIPES.map((recipe) => ({
      kind: 'shrimp' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildShrimp(recipe, ctx),
    })),
    ...HERMIT_RECIPES.map((recipe) => ({
      kind: 'crab' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildHermit(recipe, ctx),
    })),
    ...NERITE_RECIPES.map((recipe) => ({
      kind: 'snail' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildNerite(recipe, ctx),
    })),
    { kind: 'anemone' as const, id: 'host-anemone', run: (ctx: FishContext) => buildAnemone(ctx) },
    ...ENVIRONMENT_RECIPES.map((recipe) => ({
      kind: recipe.kind,
      id: recipe.id,
      run: (ctx: FishContext) => buildEnvironment(recipe, ctx),
    })),
    ...LEAF_CARD_RECIPES.map((recipe) => ({
      kind: 'decor' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildLeafCard(recipe, ctx),
    })),
    ...ROCK_PILE_RECIPES.map((recipe) => ({
      kind: 'rock' as const,
      id: recipe.id,
      run: (ctx: FishContext) =>
        buildRockPile(recipe, new Map(ENVIRONMENT_RECIPES.map((r) => [r.id, r])), ctx),
    })),
    ...MANGROVE_ENVIRONMENT_RECIPES.map((recipe) => ({
      kind: recipe.kind,
      id: recipe.id,
      run: (ctx: FishContext) => buildEnvironment(recipe, ctx),
    })),
    ...MANGROVE_SUBSTRATE_RECIPES.map((recipe) => ({
      kind: 'substrate' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildSubstrate(recipe, ctx),
    })),
    ...SUBSTRATE_RECIPES.map((recipe) => ({
      kind: 'substrate' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildSubstrate(recipe, ctx),
    })),
    ...HDRI_RECIPES.map((recipe) => ({
      kind: 'hdri' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildHdri(recipe, ctx),
    })),
    ...[...LOFT_FISH_RECIPES, ...BLACKWATER_FISH_RECIPES].map((recipe) => ({
      kind: 'fish' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildLoftFish(recipe, ctx),
    })),
    ...MANGROVE_LOFT_RECIPES.map((recipe) => ({
      kind: 'fish' as const,
      id: recipe.id,
      run: (ctx: FishContext) => buildLoftFish(recipe, ctx),
    })),
    ...AUDIO_RECIPES.map((recipe) => ({
      kind: 'audio' as const,
      id: recipe.id,
      run: (ctx: FishContext) =>
        Promise.resolve(buildAudio(recipe, ctx, RAW_ROOT, ctx.licenceOf(recipe.source))),
    })),
    ...backgrounds.map((entry) => ({
      kind: 'background' as const,
      id: entry.id,
      run: async (ctx: FishContext) => {
        const built = await buildBackground(entry, ctx);
        previews.set(entry.id, built.preview);
        return built.asset;
      },
    })),
  ];
}

export async function build(options: BuildOptions): Promise<void> {
  const { repoRoot, only, impostorSheetDir } = options;
  const previews = new Map<string, Rgba>();
  const atlases = new Map<string, Atlas>();
  const outRoot = join(repoRoot, 'apps', 'web', 'public', 'assets');
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'manifest.json'), 'utf8')),
  );
  const licences = new Map(manifest.assets.map((a) => [a.id, a.licence]));
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const verified = new Set<string>();
  const ctx: FishContext = {
    ...(impostorSheetDir
      ? { atlasSink: (id: string, atlas: Atlas) => atlases.set(id, atlas) }
      : {}),
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

  const backgrounds = manifest.assets.filter((a) => a.kind === 'background');
  const buildable = new Set(tasks(backgrounds, previews).map((t) => `${t.kind}/${t.id}`));
  for (const key of [...previous.keys()].filter((k) => !buildable.has(k))) {
    console.log(`index.json: dropping ${key}, it has no build task any more`);
    previous.delete(key);
  }

  await readyCodecs();
  const selected = tasks(backgrounds, previews).filter(
    (t) => only.length === 0 || only.includes(t.id),
  );
  if (only.length > 0 && selected.length !== only.length) {
    const known = tasks(backgrounds, previews).map((t) => t.id);
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

  if (impostorSheetDir && atlases.size > 0) {
    mkdirSync(impostorSheetDir, { recursive: true });
    for (const [id, atlas] of atlases)
      writeFileSync(join(impostorSheetDir, `${id}.png`), await contactSheet([atlas]));
    if (atlases.size > 1)
      writeFileSync(
        join(impostorSheetDir, 'contact-sheet.png'),
        await contactSheet([...atlases.values()]),
      );
  }

  if (previews.size > 0) {
    const builtIds = new Set(previews.keys());
    for (const path of syncContentFiles(repoRoot, builtIds)) console.log(`updated ${path}`);
    if (options.backgroundSheet) {
      mkdirSync(dirname(options.backgroundSheet), { recursive: true });
      writeFileSync(
        options.backgroundSheet,
        await backgroundSheet([...previews].map(([id, image]) => ({ id, image }))),
      );
    }
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
