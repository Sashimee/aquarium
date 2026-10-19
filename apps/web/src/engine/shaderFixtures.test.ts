import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  PlaneGeometry,
  type MagnificationTextureFilter,
  type MinificationTextureFilter,
} from 'three/webgpu';
import { float, texture, uv } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { assertSamplersDeclared, buildShaders } from './shaderFixtures';

const SRC = join(__dirname, '..');

/** Every file calling `.bias()`, each with a test that builds its shader through `buildShaders`. */
const BIAS_SITES_WITH_FIXTURE_TESTS = ['engine/tank/Tank.ts', 'engine/water/caustics.ts'];

function biasedPlane(
  minFilter: MinificationTextureFilter,
  magFilter: MagnificationTextureFilter,
): Mesh {
  const map = new DataTexture(new Uint8Array(16), 2, 2);
  map.minFilter = minFilter;
  map.magFilter = magFilter;
  const material = new MeshBasicNodeMaterial();
  material.colorNode = texture(map, uv()).bias(float(1)).rgb;
  return new Mesh(new PlaneGeometry(), material);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('buildShaders sampler guard', () => {
  it('rejects a nearest-filtered texture sampled with .bias()', () => {
    expect(() => buildShaders(biasedPlane(NearestFilter, NearestFilter), 'webgpu')).toThrow(
      /undeclared \w+_sampler/,
    );
  });

  it('accepts the same texture once it is filterable', () => {
    const { fragment } = buildShaders(
      biasedPlane(LinearMipmapLinearFilter, LinearFilter),
      'webgpu',
    );
    expect(fragment).toMatch(/textureSampleBias\(/);
  });

  it('leaves GLSL alone, which has no separate samplers', () => {
    expect(() => buildShaders(biasedPlane(NearestFilter, NearestFilter), 'webgl')).not.toThrow();
  });

  it('accepts comparison samplers and names every undeclared one', () => {
    expect(() =>
      assertSamplersDeclared(
        'var d_sampler : sampler_comparison;\ntextureSampleCompare(d, d_sampler, uv, 0.5)',
        'fragment',
      ),
    ).not.toThrow();
    expect(() =>
      assertSamplersDeclared('textureSampleBias(a, a_sampler, uv, 1.0) + b_sampler', 'fragment'),
    ).toThrow(/fragment shader samples through undeclared a_sampler, b_sampler/);
  });

  it('covers every .bias() call site with a fixture-built shader', () => {
    const sites = sourceFiles(SRC)
      .filter((file) => /\.bias\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .sort();
    expect(sites).toEqual(BIAS_SITES_WITH_FIXTURE_TESTS);
  });
});
