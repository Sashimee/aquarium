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
