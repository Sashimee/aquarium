import { describe, expect, it } from 'vitest';
import {
  AdditiveBlending,
  CustomBlending,
  MaterialBlending,
  MeshBasicNodeMaterial,
  MultiplyBlending,
  NoBlending,
  NormalBlending,
  SubtractiveBlending,
  type Blending,
} from 'three/webgpu';
import { blendsVelocity, temporalOutputs } from './post';

type Rgba = readonly [number, number, number, number];
type Factor = 'zero' | 'one' | 'srcAlpha' | 'oneMinusSrcAlpha' | 'srcColor' | 'oneMinusSrcColor';

function weight(factor: Factor, src: Rgba, channel: number): number {
  switch (factor) {
    case 'zero':
      return 0;
    case 'one':
      return 1;
    case 'srcAlpha':
      return src[3];
    case 'oneMinusSrcAlpha':
      return 1 - src[3];
    case 'srcColor':
      return src[channel] ?? 0;
    case 'oneMinusSrcColor':
      return 1 - (src[channel] ?? 0);
  }
}

function blend(src: Rgba, dst: Rgba, srcFactor: Factor, dstFactor: Factor): number[] {
  return dst.map(
    (d, i) => (src[i] ?? 0) * weight(srcFactor, src, i) + d * weight(dstFactor, src, i),
  );
}

describe('the velocity a blended material writes under TRAA', () => {
  const opaqueVelocity: Rgba = [0.012, -0.004, 0, 1];
  const written: Rgba = [0, 0, 0, 0];

  // three's factors for its blending presets, and the custom ones the tank's in-scatter uses.
  it.each([
    ['normal', 'srcAlpha', 'oneMinusSrcAlpha'],
    ['normal, premultiplied', 'one', 'oneMinusSrcAlpha'],
    ['additive', 'srcAlpha', 'one'],
    ['additive, premultiplied', 'one', 'one'],
    ['subtractive', 'zero', 'oneMinusSrcColor'],
    ['tank in-scatter', 'one', 'one'],
  ] as const)('leaves the opaque velocity under %s blending', (_name, src, dst) => {
    expect(blend(written, opaqueVelocity, src, dst)).toEqual([...opaqueVelocity]);
  });

  it('would zero it under multiply blending, so a multiplying material sets its own', () => {
    expect(blend(written, opaqueVelocity, 'zero', 'srcColor')).toEqual([0, 0, 0, 0]);
  });
});

describe('blendsVelocity', () => {
  function material(transparent: boolean, blending: Blending): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent });
    m.blending = blending;
    return m;
  }

  it.each([
    NormalBlending,
    AdditiveBlending,
    SubtractiveBlending,
    MultiplyBlending,
    CustomBlending,
  ])('is true for a transparent material blending with mode %s', (blending) => {
    expect(blendsVelocity(material(true, blending))).toBe(true);
  });

  it('is false for an opaque material, which writes its own velocity', () => {
    expect(blendsVelocity(material(false, NormalBlending))).toBe(false);
  });

  it.each([AdditiveBlending, SubtractiveBlending, MultiplyBlending, CustomBlending])(
    'is true for an opaque material blending with mode %s, which three blends anyway',
    (blending) => {
      expect(blendsVelocity(material(false, blending))).toBe(true);
    },
  );

  it('is false for a transparent material that does not blend, and so overwrites', () => {
    expect(blendsVelocity(material(true, NoBlending))).toBe(false);
  });
});

describe('temporalOutputs', () => {
  it('blends the velocity attachment as each material blends, like the colour', () => {
    const outputs = temporalOutputs();
    expect(outputs.getBlendMode('velocity').blending).toBe(MaterialBlending);
    expect(outputs.getBlendMode('output').blending).toBe(MaterialBlending);
    expect(Object.keys(outputs.outputNodes)).toEqual(['output', 'velocity']);
  });
});
