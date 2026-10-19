import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkAssets, loadCheckInput } from './check.ts';
import { sha256 } from './glb.ts';
import { derivedModifications } from './manifest.ts';

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
  console.error(
    'usage: cli.ts check | sync-manifest | render-misty-lake | build [asset-id ...] [--impostor-sheets=dir] [--background-sheet=file.png]',
  );
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
