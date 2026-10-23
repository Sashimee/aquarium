import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkAssets, loadCheckInput } from './check.ts';
import { sha256 } from './glb.ts';
import { aggregateSha256, derivedModifications, manifestSchema } from './manifest.ts';
import { verifyRawSource } from './source.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'check') {
    const input = loadCheckInput(REPO_ROOT);
    const problems = checkAssets(input);
    if (problems.length > 0) {
      console.error(`assets:check failed with ${problems.length} problem(s):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      return 1;
    }
    console.log(
      `assets:check ok: ${input.manifest.assets.length} manifest entries, ${input.index.assets.length} built assets, ${(input.index.totalBytes / 1e6).toFixed(1)} MB`,
    );
    return 0;
  }
  if (command === 'sync-manifest') {
    const input = loadCheckInput(REPO_ROOT);
    const derived = derivedModifications(input.index, input.manifest);
    const path = join(REPO_ROOT, 'assets', 'manifest.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      assets: { id: string; kind: string; modifications: string[] }[];
    };
    for (const asset of raw.assets) {
      const modifications = derived.get(asset.id);
      if (modifications) asset.modifications = modifications;
    }
    const { format, resolveConfig } = await import('prettier');
    const options = (await resolveConfig(path)) ?? {};
    writeFileSync(path, await format(JSON.stringify(raw), { ...options, filepath: path }));
    return 0;
  }
  if (command === 'build') {
    const { build } = await import('./build.ts');
    const sheets = rest.find((a) => a.startsWith('--impostor-sheets='));
    const backgroundSheet = rest.find((a) => a.startsWith('--background-sheet='));
    await build({
      repoRoot: REPO_ROOT,
      ...(backgroundSheet
        ? { backgroundSheet: resolve(backgroundSheet.slice('--background-sheet='.length)) }
        : {}),
      only: rest.filter((a) => !a.startsWith('--')),
      ...(sheets ? { impostorSheetDir: resolve(sheets.slice('--impostor-sheets='.length)) } : {}),
    });
    return 0;
  }
  if (command === 'render-misty-lake') {
    const { MISTY_LAKE_ID, renderMistyLake } = await import('./misty-lake.ts');
    const rendered = await renderMistyLake(REPO_ROOT);
    const manifestPath = join(REPO_ROOT, 'assets', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      assets: { id: string; sha256: string | null; status: string }[];
    };
    const entry = raw.assets.find((a) => a.id === MISTY_LAKE_ID);
    if (!entry) throw new Error(`${MISTY_LAKE_ID} is not in assets/manifest.json`);
    entry.sha256 = sha256(readFileSync(rendered));
    entry.status = 'downloaded';
    const { format, resolveConfig } = await import('prettier');
    const options = (await resolveConfig(manifestPath)) ?? {};
    writeFileSync(
      manifestPath,
      await format(JSON.stringify(raw), { ...options, filepath: manifestPath }),
    );
    console.log(`rendered ${rendered}; recorded sha256 ${entry.sha256} in assets/manifest.json`);
    return 0;
  }
  if (command === 'render-cichlid-backgrounds' || command === 'render-water-backgrounds') {
    const { renderAllCichlidBackgrounds } = await import('./cichlid-render.ts');
    const { renderAllWaterBackgrounds } = await import('./water-render.ts');
    const renderAll =
      command === 'render-cichlid-backgrounds'
        ? renderAllCichlidBackgrounds
        : renderAllWaterBackgrounds;
    const only = rest.filter((a) => !a.startsWith('--'));
    const manifestPath = join(REPO_ROOT, 'assets', 'manifest.json');
    let text = readFileSync(manifestPath, 'utf8');
    const manifest = manifestSchema.parse(JSON.parse(text));
    const byId = new Map(manifest.assets.map((a) => [a.id, a]));
    const verified = new Set<string>();
    const rendered = await renderAll(
      {
        verifySource: (sourceId) => {
          if (verified.has(sourceId)) return;
          const source = byId.get(sourceId);
          if (!source) throw new Error(`${sourceId} is not in assets/manifest.json`);
          verifyRawSource(source, aggregateSha256);
          verified.add(sourceId);
        },
      },
      only,
    );
    for (const file of rendered) {
      const id = basename(dirname(file));
      const digest = sha256(readFileSync(file));
      const at = text.indexOf(`"id": "${id}"`);
      if (at < 0) throw new Error(`${id} is not in assets/manifest.json`);
      const head = text.slice(0, at);
      const tail = text
        .slice(at)
        .replace(/"sha256": (null|"[0-9a-f]{64}")/, `"sha256": "${digest}"`)
        .replace(/"status": "[a-z_]+"/, '"status": "downloaded"');
      text = head + tail;
      console.log(`rendered ${file}; sha256 ${digest}`);
    }
    writeFileSync(manifestPath, text);
    return 0;
  }
  console.error(
    'usage: cli.ts check | sync-manifest | render-misty-lake | render-cichlid-backgrounds [id ...] | render-water-backgrounds [id ...] | build [asset-id ...] [--impostor-sheets=dir] [--background-sheet=file.png]',
  );
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
