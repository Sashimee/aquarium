import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@aquarium/'));

const speciesDir = new URL('../../content/species/', import.meta.url);
const species = readdirSync(speciesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, speciesDir), 'utf8')));
if (species.length === 0) throw new Error('content/species has no species files.');
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/species.json', import.meta.url), JSON.stringify(species));

writeFileSync(
  new URL('./dist/chemistry.json', import.meta.url),
  readFileSync(new URL('../../content/chemistry.json', import.meta.url)),
);

writeFileSync(
  new URL('./dist/plants.json', import.meta.url),
  readFileSync(new URL('../../content/plants.json', import.meta.url)),
);

writeFileSync(
  new URL('./dist/economy.json', import.meta.url),
  readFileSync(new URL('../../content/economy.json', import.meta.url)),
);

const presets = Object.fromEntries(
  ['freshwater', 'reef'].map((biome) => [
    biome,
    JSON.parse(
      readFileSync(new URL(`../../content/presets/${biome}.json`, import.meta.url), 'utf8'),
    ),
  ]),
);
writeFileSync(new URL('./dist/presets.json', import.meta.url), JSON.stringify(presets));

const manifest = JSON.parse(
  readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8'),
);
writeFileSync(new URL('./dist/manifest.json', import.meta.url), JSON.stringify(manifest));

const options = {
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: runtimeDeps.flatMap((name) => [name, `${name}/*`]),
  logLevel: 'info',
};

if (process.argv.includes('--dev')) {
  const ctx = await context(options);
  await ctx.rebuild();
  await ctx.watch();
  const child = spawn(process.execPath, ['--watch', '--enable-source-maps', 'dist/server.js'], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  await build(options);
}
