import { execFileSync } from 'node:child_process';

const [part, describe, ...listArgs] = process.argv.slice(2);
const match = /^(\d+(?:,\d+)*)\/(\d+)$/.exec(part ?? '');
if (!match || !describe) {
  console.error(
    'usage: e2e-slice.mjs <index[,index...]>/<count> <describe title> [playwright args]',
  );
  process.exit(2);
}
const indexes = match[1].split(',').map(Number);
const count = Number(match[2]);
if (indexes.some((index) => index < 1 || index > count)) {
  console.error(`part ${part} is out of range`);
  process.exit(2);
}

const list = (extra) =>
  execFileSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts', '--list', ...extra],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

function collect(suite, path, out) {
  const here = suite.title ? [...path, suite.title] : path;
  for (const spec of suite.specs ?? []) out.push([...here, spec.title]);
  for (const child of suite.suites ?? []) collect(child, here, out);
}

const tree = JSON.parse(list(['--reporter=json', ...listArgs]));
const paths = [];
for (const suite of tree.suites) collect(suite, [], paths);

const inDescribe = paths
  .filter((path) => path.includes(describe))
  .map((path) => path.slice(path.indexOf(describe)).join(' '));
if (inDescribe.length < count) {
  console.error(`"${describe}" has ${inDescribe.length} tests, too few for ${count} parts`);
  process.exit(1);
}

// Round-robin puts neighbouring tests, which cost about the same, in different parts.
const mine = inDescribe.filter((_, i) => indexes.includes((i % count) + 1));
if (inDescribe.some((title) => /[\r\n]/.test(title))) {
  console.error('a test title contains a line break, which cannot go through GITHUB_ENV');
  process.exit(1);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const grep = mine.map(escape).join('|');

const total = /^Total: (\d+) tests? in /m.exec(
  list(['--reporter=list', ...listArgs, `--grep=${grep}`]),
);
const selected = Number(total?.[1]);
if (selected !== mine.length) {
  console.error(`part ${part} should select ${mine.length} tests but the grep selects ${selected}`);
  process.exit(1);
}
process.stdout.write(grep);
