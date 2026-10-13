import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// esbuild lives in the api package; the bundle goes into apps/api/dist so its runtime
// dependencies, species.json and manifest.json resolve exactly as in production.
const apiPackage = new URL('../apps/api/package.json', import.meta.url);
const { build } = createRequire(apiPackage)('esbuild');
const pkg = JSON.parse(readFileSync(apiPackage, 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@aquarium/'));

await build({
  entryPoints: [new URL('./server.ts', import.meta.url).pathname],
  outfile: new URL('../apps/api/dist/e2e-server.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: runtimeDeps.flatMap((name) => [name, `${name}/*`]),
  logLevel: 'warning',
});
