import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@aquarium/'));

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
