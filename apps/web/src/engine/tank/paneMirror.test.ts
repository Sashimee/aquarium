import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { float, uniform, vec2 } from 'three/tsl';
import { evaluate } from '../shaderFixtures';
import {
  AGREEMENT_FADE,
  agreementFade,
  EDGE_FADE,
  MIN_UNFOG_TRANSMITTANCE,
  refog,
  screenEdgeFade,
} from './paneMirror';

function edge(u: number, v: number): number {
  const [w] = evaluate(screenEdgeFade(vec2(float(u), float(v))));
  return w ?? Number.NaN;
}

function agreement(cosine: number): number {
  const [w] = evaluate(agreementFade(float(cosine)));
  return w ?? Number.NaN;
}

const v3 = (x: number, y: number, z: number) => uniform(new Vector3(x, y, z));

describe('screenEdgeFade', () => {
  it('keeps the copy in full inside the screen', () => {
    expect(edge(0.5, 0.5)).toBe(1);
    expect(edge(EDGE_FADE, 1 - EDGE_FADE)).toBeCloseTo(1, 9);
  });

  it('fades it linearly towards any edge', () => {
    expect(edge(EDGE_FADE / 2, 0.5)).toBeCloseTo(0.5, 9);
    expect(edge(0.5, 1 - EDGE_FADE / 4)).toBeCloseTo(0.25, 9);
    expect(edge(0, 0.5)).toBe(0);
  });

  it('drops it entirely off screen', () => {
    expect(edge(-0.2, 0.5)).toBe(0);
    expect(edge(0.5, 1.3)).toBe(0);
  });
});

describe('agreementFade', () => {
  const [from, to] = AGREEMENT_FADE;

  it('drops the copy where the mirror and the camera see the end from apart', () => {
    expect(agreement(from)).toBe(0);
    expect(agreement(-1)).toBe(0);
  });

  it('keeps it where they agree, rising linearly between', () => {
    expect(agreement(to)).toBeCloseTo(1, 9);
    expect(agreement(1)).toBe(1);
    expect(agreement((from + to) / 2)).toBeCloseTo(0.5, 9);
  });
});

describe('refog', () => {
  it('moves light seen along one path through the water onto another', () => {
    const leaving = [0.3, 0.5, 0.7];
    const camera = { t: [0.6, 0.8, 0.9], s: [0.02, 0.03, 0.04] };
    const mirror = { t: [0.4, 0.7, 0.85], s: [0.05, 0.06, 0.07] };
    const seen = leaving.map((l, i) => l * (camera.t[i] ?? 0) + (camera.s[i] ?? 0));
    const result = evaluate(
      refog(
        v3(seen[0] ?? 0, seen[1] ?? 0, seen[2] ?? 0),
        v3(camera.t[0] ?? 0, camera.t[1] ?? 0, camera.t[2] ?? 0),
        v3(camera.s[0] ?? 0, camera.s[1] ?? 0, camera.s[2] ?? 0),
        v3(mirror.t[0] ?? 0, mirror.t[1] ?? 0, mirror.t[2] ?? 0),
        v3(mirror.s[0] ?? 0, mirror.s[1] ?? 0, mirror.s[2] ?? 0),
      ),
    );
    leaving.forEach((l, i) => {
      expect(result[i]).toBeCloseTo(l * (mirror.t[i] ?? 0) + (mirror.s[i] ?? 0), 9);
    });
  });

  it('leaves light along the same path as it was', () => {
    const result = evaluate(
      refog(
        v3(0.4, 0.5, 0.6),
        v3(0.7, 0.8, 0.9),
        v3(0.01, 0.02, 0.03),
        v3(0.7, 0.8, 0.9),
        v3(0.01, 0.02, 0.03),
      ),
    );
    expect(result[0]).toBeCloseTo(0.4, 9);
    expect(result[1]).toBeCloseTo(0.5, 9);
    expect(result[2]).toBeCloseTo(0.6, 9);
  });

  it('takes back at most 1 / MIN_UNFOG_TRANSMITTANCE of the dimming, and never goes negative', () => {
    const [dense] = evaluate(
      refog(v3(0.5, 0, 0), v3(0.01, 1, 1), v3(0, 0, 0), v3(1, 1, 1), v3(0, 0, 0)),
    );
    expect(dense).toBeCloseTo(0.5 / MIN_UNFOG_TRANSMITTANCE, 9);
    const [haze] = evaluate(
      refog(v3(0.01, 0, 0), v3(0.5, 1, 1), v3(0.05, 0, 0), v3(0.5, 1, 1), v3(0, 0, 0)),
    );
    expect(haze).toBe(0);
  });
});
