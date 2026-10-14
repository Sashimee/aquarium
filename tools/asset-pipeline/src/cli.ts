import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkAssets, loadCheckInput } from './check.ts';
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
      assets: { id: string; modifications: string[] }[];
    };
    for (const asset of raw.assets) {
      const modifications = derived.get(asset.id);
      if (modifications) asset.modifications = modifications;
    }
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    return 0;
  }
  if (command === 'build') {
    const { build } = await import('./build.ts');
    await build({ repoRoot: REPO_ROOT, only: rest.filter((a) => !a.startsWith('--')) });
    return 0;
  }
  console.error('usage: cli.ts check | sync-manifest | build [asset-id ...]');
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
