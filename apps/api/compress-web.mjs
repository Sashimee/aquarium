import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const COMPRESSIBLE = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.gltf',
  '.wasm',
  '.map',
  '.hdr',
  '.txt',
]);
const MIN_BYTES = 1024;
const MAX_RATIO = 0.9;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

const root = resolve(process.argv[2] ?? new URL('../web/dist', import.meta.url).pathname);
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`${root} does not exist. Build the web app first, or pass the dist directory.`);
}

let written = 0;
for (const file of walk(root)) {
  if (!COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
  const data = readFileSync(file);
  if (data.length < MIN_BYTES) continue;
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = gzipSync(data, { level: 9 });
  if (br.length < data.length * MAX_RATIO) {
    writeFileSync(`${file}.br`, br);
    written++;
  }
  if (gz.length < data.length * MAX_RATIO) {
    writeFileSync(`${file}.gz`, gz);
    written++;
  }
}
console.log(`compress-web: wrote ${written} precompressed files under ${root}`);
