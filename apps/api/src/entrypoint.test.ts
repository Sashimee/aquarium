import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = readFileSync(resolve(__dirname, '../../../docker/entrypoint.sh'), 'utf8');

let root: string;

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

function run(retention?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (retention !== undefined) env.ASSET_RETENTION_DAYS = retention;
  return spawnSync('sh', [join(root, 'entrypoint.sh'), 'echo', 'started'], {
    encoding: 'utf8',
    env,
  });
}

describe('docker/entrypoint.sh', () => {
  it('copies current assets, leaves no temp files, and execs the command', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('started');
    expect(readdirSync(join(root, 'assets'), { encoding: 'utf8' })).toEqual(['a.js']);
    expect(readFileSync(join(root, 'assets', 'a.js'), 'utf8')).toBe('new');
  });

  it.each(['07', '007', '0', '00'])('accepts ASSET_RETENTION_DAYS=%s as decimal', (v) => {
    expect(run(v).status).toBe(0);
  });

  it.each(['abc', '-1', '1.5'])('rejects ASSET_RETENTION_DAYS=%j naming the variable', (v) => {
    const r = run(v);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ASSET_RETENTION_DAYS');
  });
});
