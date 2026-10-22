import { LinearFilter, type Node } from 'three/webgpu';
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  dot,
  float,
  Fn,
  getScreenPosition,
  If,
  max,
  min,
  mix,
  normalize,
  screenSize,
  step,
  vec2,
  vec3,
  vec4,
  viewportTexture,
} from 'three/tsl';
import type { WaterMedium } from '../water/medium';
import { SOFT_EDGE_TEXELS, TAPS } from './surfaceReflection';

/** Within this share of the screen from its edge the copy fades out, as it has nothing beyond. */
export const EDGE_FADE = 0.04;
/**
 * The cosine between the mirrored ray and the camera's line of sight to where that ray ends, over
 * which the copy fades in: the camera sees that point from a direction the mirror does not, so
 * what stands in front of it is placed the less faithfully the more the two part.
 */
export const AGREEMENT_FADE: readonly [number, number] = [0.5, 0.8];
/** Below this transmittance the camera's own haze is not taken back out of the copy. */
export const MIN_UNFOG_TRANSMITTANCE = 0.1;

/** 1 inside the screen, falling linearly to 0 over `EDGE_FADE` towards and past its edge. */
export function screenEdgeFade(uv: Node<'vec2'>): Node<'float'> {
  const inner = min(min(uv.x, uv.y), min(uv.x.oneMinus(), uv.y.oneMinus()));
  return max(min(inner.div(EDGE_FADE), 1), 0);
}

/** 0 up to the first `AGREEMENT_FADE` cosine, rising linearly to 1 at the second. */
export function agreementFade(cosine: Node<'float'>): Node<'float'> {
  const [from, to] = AGREEMENT_FADE;
  return max(min(cosine.sub(from).div(to - from), 1), 0);
}

/**
 * Light the camera saw through `cameraTransmittance` with `cameraInScatter` added on the way, as
 * it would arrive along another path through the water instead.
 */
export function refog(
  colour: Node<'vec3'>,
  cameraTransmittance: Node<'vec3'>,
  cameraInScatter: Node<'vec3'>,
  transmittance: Node<'vec3'>,
  inScatter: Node<'vec3'>,
): Node<'vec3'> {
  const leaving = max(colour.sub(cameraInScatter), vec3(0)).div(
    max(cameraTransmittance, vec3(MIN_UNFOG_TRANSMITTANCE)),
  );
  return leaving.mul(transmittance).add(inScatter);
}

/**
 * A pane's mirror of the tank's contents taken from the scene drawn so far. The glass draws after
 * everything in the water, so a copy of the frame just before it holds the plants, decor and fish.
 * A plane mirror shows, at each fragment, what lies along the mirrored ray: this takes it to be
 * whatever the camera sees where that ray ends on the backdrop or the floor, with the water along
 * the camera's path swapped for the water along the mirrored one. That is exact where the two
 * lines of sight agree and only placed less faithfully where they part, so it fades to the traced
 * mirror there, off screen and wherever the ray leaves through a pane.
 */
export class PaneMirror {
  private readonly frame = viewportTexture();

  constructor() {
    // The copy has one level; a mipmapped filter would make it incomplete on WebGL.
    this.frame.value.minFilter = LinearFilter;
  }

  /**
   * The radiance mirrored along `dir` from `origin`, the fragment on the pane, where `gate` is
   * true: `end` is where that ray leaves the water and `endsInTank` is 1 where it ends on the
   * backdrop or the floor. Elsewhere, and where the copy cannot stand in, it is `fallback`.
   */
  radiance(
    medium: WaterMedium,
    origin: Node<'vec3'>,
    dir: Node<'vec3'>,
    end: Node<'vec3'>,
    endsInTank: Node<'float'>,
    gate: Node<'bool'>,
    fallback: Node<'vec3'>,
  ): Node<'vec3'> {
    return Fn(() => {
      const result = vec3(fallback).toVar();
      If(gate.and(endsInTank.greaterThan(0)), () => {
        const view = cameraViewMatrix.mul(vec4(end, 1)).xyz.toVar();
        const uv = getScreenPosition(view, cameraProjectionMatrix).toVar();
        const tap = vec2(SOFT_EDGE_TEXELS).div(screenSize).toVar();
        let colour: Node<'vec3'> = vec3(0);
        for (const [dx, dy] of TAPS) {
          const at = uv.add(tap.mul(vec2(dx, dy)));
          colour = colour.add(this.frame.sample(at).level(float(0)).rgb);
        }
        const seen = medium.fogTowardsCamera(end);
        const length = end.sub(origin).length();
        const across = medium.transmittance(length).toVar();
        const midDepth = medium.boxMax.y.sub(origin.y.add(end.y).mul(0.5));
        const mirrored = refog(
          colour.div(TAPS.length),
          seen.transmittance,
          seen.inScatter,
          across,
          medium.inScatter(across, midDepth),
        );
        const agreement = dot(dir, normalize(end.sub(cameraPosition)));
        const weight = endsInTank
          .mul(screenEdgeFade(uv))
          .mul(agreementFade(agreement))
          .mul(step(view.z, 0));
        result.assign(mix(fallback, mirrored, weight));
      });
      return result;
    })();
  }
}
