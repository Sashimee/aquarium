import { describe, expect, it, vi } from 'vitest';
import { Box3, RenderTarget, Vector3, type NodeFrame } from 'three/webgpu';
import { float, uniform, vec2 } from 'three/tsl';
import { evaluate } from '../shaderFixtures';
import { WaterMedium } from '../water/medium';
import {
  AGREEMENT_FADE,
  agreementFade,
  EDGE_FADE,
  FULL_REFLECTANCE,
  IN_TANK_FADE,
  inTankFade,
  MIN_REFLECTANCE,
  MIN_UNFOG_TRANSMITTANCE,
  mirrorPresence,
  PaneMirror,
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

const medium = new WaterMedium(new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.4, 0.2)), {
  cdom440: 0.05,
  turbidity: 0.08,
});

function fadeAt(x: number, y: number, z: number): number {
  const [w] = evaluate(inTankFade(v3(x, y, z), medium.boxMin, medium.boxMax));
  return w ?? Number.NaN;
}

/** The in-tank fade where the ray from `origin` along `dir` leaves the water. */
function fadeAlong(origin: Vector3, dir: Vector3): number {
  const o = v3(origin.x, origin.y, origin.z);
  const d = dir.clone().normalize();
  const along = v3(d.x, d.y, d.z);
  const end = o.add(along.mul(medium.exit(o, along).distance));
  const [w] = evaluate(inTankFade(end, medium.boxMin, medium.boxMax));
  return w ?? Number.NaN;
}

/** The fade along a sweep of rays, and the largest change between neighbouring ones. */
function sweep(origin: Vector3, dirAt: (s: number) => Vector3, from: number, to: number) {
  const steps = 10_000;
  const values = Array.from({ length: steps + 1 }, (_, i) =>
    fadeAlong(origin, dirAt(from + ((to - from) * i) / steps)),
  );
  const jump = Math.max(...values.slice(1).map((v, i) => Math.abs(v - (values[i] ?? v))));
  return { first: values[0], last: values[steps], jump };
}

describe('inTankFade', () => {
  it('keeps the copy in full on the backdrop and the floor away from their edges', () => {
    expect(fadeAt(0, 0.2, -0.2)).toBe(1);
    expect(fadeAt(0.2, 0, 0)).toBe(1);
  });

  it('is 0 wherever the ray leaves through the surface or a pane', () => {
    expect(fadeAt(0, 0.4, 0)).toBe(0);
    expect(fadeAt(-0.5, 0.2, 0)).toBe(0);
    expect(fadeAt(0.5, 0.2, 0)).toBe(0);
    expect(fadeAt(0, 0.2, 0.2)).toBe(0);
  });

  it('falls linearly towards each of those edges', () => {
    expect(fadeAt(0, 0.4 - IN_TANK_FADE / 2, -0.2)).toBeCloseTo(0.5, 9);
    expect(fadeAt(-0.5 + IN_TANK_FADE / 4, 0.2, -0.2)).toBeCloseTo(0.25, 9);
    expect(fadeAt(0, 0, 0.2 - IN_TANK_FADE / 2)).toBeCloseTo(0.5, 9);
  });

  const onLeftPane = new Vector3(-0.5, 0.2, 0.1);

  it('has no step where the mirrored ray moves from the backdrop to the surface', () => {
    const { first, last, jump } = sweep(onLeftPane, (s) => new Vector3(0.3, s, -1), 0, 1.5);
    expect(first).toBe(1);
    expect(last).toBe(0);
    expect(jump).toBeLessThan(0.02);
  });

  it('has no step where it moves from the backdrop to the opposite pane', () => {
    const { first, last, jump } = sweep(onLeftPane, (s) => new Vector3(1, 0, -s), 1, 0.1);
    expect(first).toBe(1);
    expect(last).toBe(0);
    expect(jump).toBeLessThan(0.02);
  });

  it('has no step where it moves from the floor to the front pane', () => {
    const { first, last, jump } = sweep(onLeftPane, (s) => new Vector3(1, -s, 0.4), 2, 0.1);
    expect(first).toBe(1);
    expect(last).toBe(0);
    expect(jump).toBeLessThan(0.02);
  });
});

describe('mirrorPresence', () => {
  function presence(towardsWater: number, reflectance: number): number {
    const [p] = evaluate(mirrorPresence(float(towardsWater), float(reflectance)));
    return p ?? Number.NaN;
  }

  it('leaves the traced mirror alone below the threshold and on faces seen from outside', () => {
    expect(presence(1, 0)).toBe(0);
    expect(presence(1, MIN_REFLECTANCE - 0.01)).toBe(0);
    expect(presence(1, MIN_REFLECTANCE)).toBe(0);
    expect(presence(0, 1)).toBe(0);
  });

  it('takes the copy in full from FULL_REFLECTANCE up', () => {
    expect(presence(1, FULL_REFLECTANCE)).toBeCloseTo(1, 9);
    expect(presence(1, 1)).toBe(1);
  });

  it('eases in with no step at the threshold', () => {
    const steps = 1000;
    const values = Array.from({ length: steps + 1 }, (_, i) => presence(1, i / steps));
    const jumps = values.slice(1).map((v, i) => v - (values[i] ?? v));
    expect(Math.max(...jumps)).toBeLessThan(0.02);
    expect(Math.min(...jumps)).toBeGreaterThanOrEqual(0);
    expect(presence(1, MIN_REFLECTANCE + 0.005)).toBeLessThan(0.01);
  });
});

describe('PaneMirror', () => {
  it('frees the copy for a render target with that target', () => {
    const mirror = new PaneMirror();
    const target = new RenderTarget(4, 4);
    const texture = mirror.frame.sample(vec2(0.5)).getTextureForReference(target);
    const freed = vi.fn();
    texture.addEventListener('dispose', freed);
    expect(mirror.frame.copyCount).toBe(1);
    target.dispose();
    expect(freed).toHaveBeenCalledOnce();
    expect(mirror.frame.copyCount).toBe(0);
  });

  it('frees the copy when its target is resized, and keeps the same one for the next frame', () => {
    const mirror = new PaneMirror();
    const tap = mirror.frame.sample(vec2(0.5));
    const target = new RenderTarget(8, 4);
    const renderer = {
      copyFramebufferToTexture: vi.fn(),
      getRenderTarget: () => target,
      getCanvasTarget: () => null,
    };
    const frame = { renderer } as unknown as NodeFrame;
    tap.updateBefore(frame);
    const copy = tap.getTextureForReference(target);
    const freed = vi.fn();
    copy.addEventListener('dispose', freed);

    target.setSize(16, 6);
    expect(freed).toHaveBeenCalledOnce();
    expect(mirror.frame.copyCount).toBe(0);

    tap.updateBefore(frame);
    expect(renderer.copyFramebufferToTexture).toHaveBeenLastCalledWith(copy);
    expect(copy.image).toMatchObject({ width: 16, height: 6 });
    expect(mirror.frame.copyCount).toBe(1);

    target.setSize(16, 6);
    expect(freed).toHaveBeenCalledOnce();
    target.setSize(32, 12);
    expect(freed).toHaveBeenCalledTimes(2);
    expect(mirror.frame.copyCount).toBe(0);
  });

  it('frees every copy still held, and its own, when disposed', () => {
    const mirror = new PaneMirror();
    const targets = [new RenderTarget(4, 4), new RenderTarget(8, 8)];
    const freed = vi.fn();
    for (const target of targets) {
      const copy = mirror.frame.sample(vec2(0.5)).getTextureForReference(target);
      copy.addEventListener('dispose', freed);
    }
    mirror.frame.value.addEventListener('dispose', freed);
    mirror.dispose();
    expect(freed).toHaveBeenCalledTimes(3);
    expect(mirror.frame.copyCount).toBe(0);
    targets[0]?.dispose();
    expect(freed).toHaveBeenCalledTimes(3);
  });

  it('copies the frame when drawing, but not while pipelines are compiled', () => {
    const mirror = new PaneMirror();
    const tap = mirror.frame.sample(vec2(0.5));
    const target = new RenderTarget(8, 4);
    const renderer = {
      _isPreCompiling: true,
      copyFramebufferToTexture: vi.fn(),
      getRenderTarget: () => target,
      getCanvasTarget: () => null,
    };
    const frame = { renderer } as unknown as NodeFrame;
    tap.updateBefore(frame);
    expect(renderer.copyFramebufferToTexture).not.toHaveBeenCalled();
    renderer._isPreCompiling = false;
    tap.updateBefore(frame);
    expect(renderer.copyFramebufferToTexture).toHaveBeenCalledOnce();
    expect(tap.getTextureForReference(target).image).toMatchObject({ width: 8, height: 4 });
  });
});
