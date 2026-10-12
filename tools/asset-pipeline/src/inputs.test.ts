import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { speciesLengthM } from './fish.ts';
import { sha256 } from './glb.ts';
import { aggregateSha256, strictestLicence } from './manifest.ts';
import { assertSelfContainedGltf, verifyRawSource } from './source.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const lifecycle = JSON.parse(
  readFileSync(join(REPO_ROOT, 'content', 'species', 'guppy.json'), 'utf8'),
).lifecycle;

describe('speciesLengthM', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'species-'));
    mkdirSync(join(root, 'content', 'species'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (id: string, body: object): void =>
    writeFileSync(join(root, 'content', 'species', `${id}.json`), JSON.stringify(body));
  const base = {
    id: 'x',
    commonName: 'X',
    scientificName: 'Xus x',
    biome: 'freshwater',
    lifecycle,
  };

  it('is null without a species file', () => {
    expect(speciesLengthM(root, 'x')).toBeNull();
  });

  it('is null for a lifecycle-only species file', () => {
    write('x', base);
    expect(speciesLengthM(root, 'x')).toBeNull();
  });

  it('reads locomotion.bodyLengthM when present', () => {
    write('x', {
      ...base,
      locomotion: {
        swimmingMode: 'carangiform',
        gait: 'cruise',
        maxSpeedMps: 0.3,
        cruiseSpeedMps: 0.1,
        massKg: 0.001,
        maxTurnRateDegPerS: 180,
        maxPitchDeg: 30,
        bodyLengthM: 0.031,
      },
    });
    expect(speciesLengthM(root, 'x')).toBe(0.031);
  });

  it('fails loudly on a file that does not match the species schema', () => {
    write('x', { ...base, biome: 'swamp' });
    expect(() => speciesLengthM(root, 'x')).toThrow(/species schema/);
    write('x', { ...base, locomotion: { bodyLengthM: -1 } });
    expect(() => speciesLengthM(root, 'x')).toThrow(/species schema/);
  });

  it('works for every committed species file', () => {
    for (const id of ['guppy', 'neon-tetra', 'bronze-corydoras']) {
      expect(() => speciesLengthM(REPO_ROOT, id)).not.toThrow();
    }
  });
});

describe('strictestLicence', () => {
  it('picks the most restrictive licence and defaults to CC0', () => {
    expect(strictestLicence([])).toBe('CC0-1.0');
    expect(strictestLicence(['CC0-1.0', 'CC-BY-4.0'])).toBe('CC-BY-4.0');
    expect(strictestLicence(['CC-BY-4.0', 'CC-BY-SA-3.0', 'CC0-1.0'])).toBe('CC-BY-SA-3.0');
  });

  it('rejects licences it does not know', () => {
    expect(() => strictestLicence(['CC-BY-NC-4.0'])).toThrow(/unknown licence/);
  });
});

describe('assertSelfContainedGltf', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raw-'));
    mkdirSync(join(dir, 'asset', 'gltf'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function gltf(json: object): string {
    const path = join(dir, 'asset', 'gltf', 'scene.gltf');
    writeFileSync(path, JSON.stringify(json));
    return path;
  }
  const rawDir = (): string => join(dir, 'asset');

  it('accepts relative URIs inside the directory and data URIs', () => {
    const path = gltf({
      buffers: [{ uri: 'scene.bin' }],
      images: [{ uri: 'textures/a%20b.png' }, { uri: 'data:image/png;base64,AAAA' }],
    });
    expect(() => assertSelfContainedGltf(path, rawDir())).not.toThrow();
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', '../other/scene.bin'],
    ['an encoded parent traversal', '%2e%2e/other/scene.bin'],
    ['a windows-style traversal', 'textures\\..\\..\\x.png'],
    ['a file URL', 'file:///etc/passwd'],
    ['an http URL', 'https://example.com/a.png'],
  ])('rejects %s', (_label, uri) => {
    expect(() => assertSelfContainedGltf(gltf({ buffers: [{ uri }] }), rawDir())).toThrow(
      /refusing|outside|percent/,
    );
  });

  it('rejects a symlink that leaves the raw directory', () => {
    const outside = join(dir, 'outside.bin');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(dir, 'asset', 'gltf', 'link.bin'));
    expect(() =>
      assertSelfContainedGltf(gltf({ buffers: [{ uri: 'link.bin' }] }), rawDir()),
    ).toThrow(/outside/);
  });
});

describe('verifyRawSource', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rawsrc-'));
    mkdirSync(join(root, 'a'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes when every listed file and the aggregate match', () => {
    writeFileSync(join(root, 'a', 'one.bin'), 'one');
    const files = [{ path: 'one.bin', sha256: sha256('one') }];
    expect(() =>
      verifyRawSource({ id: 'a', sha256: aggregateSha256(files), files }, aggregateSha256, root),
    ).not.toThrow();
  });

  it('fails on a tampered file, a missing file and a wrong aggregate', () => {
    writeFileSync(join(root, 'a', 'one.bin'), 'tampered');
    const files = [{ path: 'one.bin', sha256: sha256('one') }];
    const source = { id: 'a', sha256: aggregateSha256(files), files };
    expect(() => verifyRawSource(source, aggregateSha256, root)).toThrow(/does not match/);
    rmSync(join(root, 'a', 'one.bin'));
    expect(() => verifyRawSource(source, aggregateSha256, root)).toThrow(/missing/);
    writeFileSync(join(root, 'a', 'one.bin'), 'one');
    expect(() =>
      verifyRawSource({ ...source, sha256: 'f'.repeat(64) }, aggregateSha256, root),
    ).toThrow(/aggregate/);
  });

  it('checks a single-file source against its own hash', () => {
    writeFileSync(join(root, 'a', 'photo.jpg'), 'pixels');
    expect(() =>
      verifyRawSource({ id: 'a', sha256: sha256('pixels') }, aggregateSha256, root),
    ).not.toThrow();
    expect(() =>
      verifyRawSource({ id: 'a', sha256: sha256('other') }, aggregateSha256, root),
    ).toThrow(/does not match/);
  });

  it('refuses a missing directory and a pending source', () => {
    expect(() =>
      verifyRawSource({ id: 'b', sha256: 'a'.repeat(64) }, aggregateSha256, root),
    ).toThrow(/missing/);
    expect(() => verifyRawSource({ id: 'a', sha256: null }, aggregateSha256, root)).toThrow(
      /pending/,
    );
  });
});
