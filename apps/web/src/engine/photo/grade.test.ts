import { describe, expect, it } from 'vitest';
import { isPhotoFilter, LUMA, type Mat3, PHOTO_FILTERS, photoGrade } from './grade';

type Rgb = readonly [number, number, number];

function apply(m: Mat3, [r, g, b]: Rgb): Rgb {
  return [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
}

function luma([r, g, b]: Rgb): number {
  return LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
}

const SAMPLES: readonly Rgb[] = [
  [0.18, 0.18, 0.18],
  [0.05, 0.3, 0.25],
  [0.9, 0.2, 0.05],
  [0.02, 0.04, 0.6],
  [1.5, 1.2, 0.8],
];

describe('photoGrade', () => {
  it('leaves the picture alone on natural', () => {
    const { matrix, contrast } = photoGrade('natural');
    expect(contrast).toBe(1);
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    matrix.forEach((v, i) => expect(v).toBeCloseTo(identity[i] ?? Number.NaN, 12));
  });

  it('keeps the brightness of white on every filter', () => {
    for (const filter of PHOTO_FILTERS) {
      expect(luma(apply(photoGrade(filter).matrix, [1, 1, 1]))).toBeCloseTo(1, 12);
    }
  });

  it('keeps grey grey and every colour as bright on the filters without a tint', () => {
    for (const filter of ['natural', 'vivid', 'bw'] as const) {
      const { matrix } = photoGrade(filter);
      const grey = apply(matrix, [0.18, 0.18, 0.18]);
      for (const channel of grey) expect(channel).toBeCloseTo(0.18, 12);
      for (const colour of SAMPLES)
        expect(luma(apply(matrix, colour))).toBeCloseTo(luma(colour), 12);
    }
  });

  it('turns every colour to its own grey on black and white', () => {
    const { matrix } = photoGrade('bw');
    for (const colour of SAMPLES) {
      const [r, g, b] = apply(matrix, colour);
      expect(g).toBeCloseTo(r, 12);
      expect(b).toBeCloseTo(r, 12);
    }
  });

  it('pushes saturation up on vivid', () => {
    const { matrix } = photoGrade('vivid');
    const colour: Rgb = [0.6, 0.2, 0.1];
    const [r, , b] = apply(matrix, colour);
    expect(r - b).toBeGreaterThan(colour[0] - colour[2]);
  });

  it('tints warm towards red and cool towards blue', () => {
    const [wr, , wb] = apply(photoGrade('warm').matrix, [0.18, 0.18, 0.18]);
    const [cr, , cb] = apply(photoGrade('cool').matrix, [0.18, 0.18, 0.18]);
    expect(wr).toBeGreaterThan(wb);
    expect(cb).toBeGreaterThan(cr);
  });

  it('only ever adds contrast, gently', () => {
    for (const filter of PHOTO_FILTERS) {
      const { contrast } = photoGrade(filter);
      expect(contrast).toBeGreaterThanOrEqual(1);
      expect(contrast).toBeLessThan(1.25);
    }
  });
});

describe('isPhotoFilter', () => {
  it('accepts the five filters and nothing else', () => {
    for (const filter of PHOTO_FILTERS) expect(isPhotoFilter(filter)).toBe(true);
    for (const other of ['sepia', '', 'BW', null, 3]) expect(isPhotoFilter(other)).toBe(false);
  });
});
