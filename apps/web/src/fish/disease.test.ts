import { describe, expect, it } from 'vitest';
import type { DiseaseState } from '@aquarium/shared';
import { writeDiseaseSigns } from './disease';

function ill(kind: DiseaseState['kind'], severity: number): DiseaseState {
  return { kind, since: '2026-10-16T08:00:00.000Z', severity, treatedUntil: null };
}

describe('writeDiseaseSigns', () => {
  it('draws a healthy fish with every sign at zero', () => {
    const out = { ich: 0.4, finRot: 0.2, velvet: 0.9 };
    writeDiseaseSigns(null, false, out);
    expect(out).toEqual({ ich: 0, finRot: 0, velvet: 0 });
  });

  it.each([
    ['ich', { ich: 0.7, finRot: 0, velvet: 0 }],
    ['fin-rot', { ich: 0, finRot: 0.7, velvet: 0 }],
    ['velvet', { ich: 0, finRot: 0, velvet: 0.7 }],
  ] as const)('puts %s severity in its own sign and clears the others', (kind, expected) => {
    const out = { ich: 1, finRot: 1, velvet: 1 };
    writeDiseaseSigns(ill(kind, 0.7), false, out);
    expect(out).toEqual(expected);
  });

  it('keeps the edges of the severity range', () => {
    const out = { ich: 0, finRot: 0, velvet: 0 };
    writeDiseaseSigns(ill('ich', 0), false, out);
    expect(out.ich).toBe(0);
    writeDiseaseSigns(ill('velvet', 1), false, out);
    expect(out).toEqual({ ich: 0, finRot: 0, velvet: 1 });
  });

  it('leaves the signs off a walker, which catches none of these diseases', () => {
    const out = { ich: 0.5, finRot: 0.5, velvet: 0.5 };
    writeDiseaseSigns(ill('fin-rot', 0.9), true, out);
    expect(out).toEqual({ ich: 0, finRot: 0, velvet: 0 });
  });

  it('rejects a severity outside 0..1', () => {
    const out = { ich: 0, finRot: 0, velvet: 0 };
    expect(() => writeDiseaseSigns(ill('ich', 1.5), false, out)).toThrow(RangeError);
    expect(() => writeDiseaseSigns(ill('ich', -0.1), false, out)).toThrow(RangeError);
    expect(() => writeDiseaseSigns(ill('ich', Number.NaN), false, out)).toThrow(RangeError);
  });
});
