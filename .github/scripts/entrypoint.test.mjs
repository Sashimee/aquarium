import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../docker/entrypoint.sh'),
  'utf8',
);

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'entrypoint-'));
  mkdirSync(join(root, 'current'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'current', 'a.js'), 'new');
  const patched = script
    .replaceAll('/app/web/assets', join(root, 'assets'))
    .replaceAll('/app/assets-current', join(root, 'current'))
    .replace('mountpoint -q "$assets"', 'true');
  writeFileSync(join(root, 'entrypoint.sh'), patched);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(retention) {
  const env = { PATH: process.env.PATH ?? '' };
  if (retention !== undefined) env.ASSET_RETENTION_DAYS = retention;
  return spawnSync('sh', [join(root, 'entrypoint.sh'), 'echo', 'started'], {
    encoding: 'utf8',
    env,
  });
}

function addOldFile(name, days) {
  const file = join(root, 'assets', name);
  writeFileSync(file, 'old');
  const t = new Date(Date.now() - days * 86400 * 1000);
  utimesSync(file, t, t);
  return file;
}

describe('docker/entrypoint.sh', () => {
  it('copies current assets, leaves no temp files, and execs the command', () => {
    const r = run();
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'started');
    assert.deepEqual(readdirSync(join(root, 'assets')), ['a.js']);
    assert.equal(readFileSync(join(root, 'assets', 'a.js'), 'utf8'), 'new');
  });

  it('reads 09 as nine days, not invalid octal', () => {
    const old = addOldFile('old.js', 8.5);
    assert.equal(run('09').status, 0);
    assert.ok(existsSync(old));
  });

  it('reads 08 as eight days', () => {
    const old = addOldFile('old.js', 8.5);
    assert.equal(run('08').status, 0);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(join(root, 'assets', 'a.js')));
  });

  for (const v of ['07', '007']) {
    it(`reads ASSET_RETENTION_DAYS=${v} as decimal seven`, () => {
      const fresh = addOldFile('six.js', 6.5);
      const stale = addOldFile('eight.js', 7.5);
      assert.equal(run(v).status, 0);
      assert.ok(existsSync(fresh));
      assert.ok(!existsSync(stale));
    });
  }

  for (const v of ['0', '00']) {
    it(`rejects ASSET_RETENTION_DAYS=${v} before touching assets`, () => {
      const old = addOldFile('old.js', 30);
      const r = run(v);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /ASSET_RETENTION_DAYS/);
      assert.ok(existsSync(old));
      assert.ok(!existsSync(join(root, 'assets', 'a.js')));
    });
  }

  for (const v of ['abc', '-1', '1.5']) {
    it(`rejects ASSET_RETENTION_DAYS=${JSON.stringify(v)} naming the variable`, () => {
      const r = run(v);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /ASSET_RETENTION_DAYS/);
    });
  }
});
