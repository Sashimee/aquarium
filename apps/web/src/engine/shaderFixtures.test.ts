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

/**
 * How many biased or gradient lookups each file makes, every one covered by a test that builds
 * its shader through `buildShaders`. Raise a count only alongside such a test.
 */
const SAMPLER_SITES_WITH_FIXTURE_TESTS: Record<string, number> = {
  'engine/tank/Tank.ts': 1,
  'engine/water/caustics.ts': 2,
};

const TSL_IMPORT = /\b(?:from|import)\s*\(?\s*['"]three\/(?:tsl|webgpu)['"]/;

const TEXTURE_CALL = /(?<![.\w])(?:texture|textureBase|cubeTexture|cubeTextureBase)\s*\(/g;

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

/**
 * `source` with comments and the bodies of string, template and regex literals blanked to spaces,
 * so a parenthesis or a call quoted in them is not read as code. Offsets are kept.
 */
function codeOnly(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`' || (c === '/' && startsRegex(source, i))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const d = source[j];
        if (d === '\\') j++;
        else if (c === '/' && d === '[') inClass = true;
        else if (c === '/' && d === ']') inClass = false;
        else if (d === c && !inClass) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function startsRegex(source: string, slash: number): boolean {
  const before = source.slice(0, slash).trimEnd();
  return before === '' || /[(,=:[!&|?{};]$|\breturn$/.test(before);
}

/** The top-level arguments of the call whose opening parenthesis ends just before `from`. */
function callArguments(source: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push(source.slice(start, i).trim());
        return args.filter((arg) => arg !== '');
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error(`unbalanced call at offset ${from}`);
}

/**
 * Lookups three's WGSL builder emits with a sampler even when the texture has none: `.bias()`,
 * `.blur()`, `.grad()`, and a bias passed as the fourth argument of `texture()` and its kin.
 */
function samplerCallSites(text: string): number {
  const source = codeOnly(text);
  const chained = (source.match(/\.(?:bias|blur|grad)\s*\(/g) ?? []).length;
  const biasArgument = [...source.matchAll(TEXTURE_CALL)].filter((m) => {
    const bias = callArguments(source, m.index + m[0].length)[3];
    return bias !== undefined && bias !== 'null' && bias !== 'undefined';
  }).length;
  return chained + biasArgument;
}

/** Only TSL code is scanned, so a DOM `element.blur()` elsewhere is not read as a texture lookup. */
function isTslSource(text: string): boolean {
  return TSL_IMPORT.test(text);
}

function tslSamplerCallSites(text: string): number {
  return isTslSource(text) ? samplerCallSites(text) : 0;
}

function callsTextureBlur(text: string): boolean {
  return isTslSource(text) && /\.blur\s*\(/.test(codeOnly(text));
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

  it('counts chained and fourth-argument bias, blur and gradient lookups', () => {
    expect(samplerCallSites('texture(a, b).bias(x).rgb; texture(c, d).bias( y )')).toBe(2);
    expect(samplerCallSites('texture(a, vec2(u, v), null, float(2))')).toBe(1);
    expect(samplerCallSites('cubeTexture(e, dir, null, blur)')).toBe(1);
    expect(samplerCallSites('texture(a, b).grad(dx, dy)')).toBe(1);
    expect(samplerCallSites('texture(a, b).blur(amount); cubeTextureBase(e, d, null, x)')).toBe(2);
    expect(samplerCallSites('texture(a, f(b, c), lod); texture(a, b, null, null)')).toBe(0);
    expect(samplerCallSites('map.texture(a, b, c, d); textureLoad(a, b, c, d)')).toBe(0);
  });

  it('ignores lookups and parentheses in comments, strings and regexes', () => {
    expect(samplerCallSites('// see texture(a, b\nconst s = ")";')).toBe(0);
    expect(samplerCallSites('/* t.bias(1) */ const s = `.grad(`; const r = /\\.blur\\(/;')).toBe(0);
    expect(samplerCallSites("texture(a, f(')'), null, b)")).toBe(1);
    expect(samplerCallSites('const r = /[\'"]/; texture(a, b).bias(x)')).toBe(1);
    expect(samplerCallSites('const half = w / 2; texture(a, b).bias(x)')).toBe(1);
  });

  it('scans only files that import TSL, so DOM blur() is not a lookup', () => {
    const dom = "const el = document.querySelector('input');\nel?.blur();";
    const tsl = "import { texture } from 'three/tsl';\nconst n = texture(t).blur(x);";
    const webgpu =
      "import {\n  MeshBasicNodeMaterial,\n} from 'three/webgpu';\nm.colorNode = texture(t).blur(x);";
    expect(tslSamplerCallSites(dom)).toBe(0);
    expect(callsTextureBlur(dom)).toBe(false);
    expect(tslSamplerCallSites(tsl)).toBe(1);
    expect(callsTextureBlur(tsl)).toBe(true);
    expect(callsTextureBlur(webgpu)).toBe(true);
    expect(callsTextureBlur("import { Vector3 } from 'three';\ntexture(t).blur(x);")).toBe(false);
  });

  it('covers every biased or gradient lookup with a fixture-built shader', () => {
    const sites = Object.fromEntries(
      sourceFiles(SRC)
        .map(
          (file) =>
            [
              relative(SRC, file).split('\\').join('/'),
              tslSamplerCallSites(readFileSync(file, 'utf8')),
            ] as const,
        )
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(sites).toEqual(SAMPLER_SITES_WITH_FIXTURE_TESTS);
  });

  // three 0.186.1 `TextureNode.blur()` checks filterability once, against the texture bound when
  // it is called: a nearest texture then loses the bias with only a warning, and one swapped in
  // later keeps it and loses its sampler. Neither a fixture nor a swap guard can vouch for that.
  it('never calls TextureNode.blur(); use .bias() with a guarded texture instead', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => callsTextureBlur(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(callers).toEqual([]);
  });
});
