import {
  LinearFilter,
  ViewportTextureNode,
  type CanvasTarget,
  type Node,
  type NodeFrame,
  type RenderTarget,
  type Texture,
  type UniformNode,
  type Vector3,
} from 'three/webgpu';
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
/**
 * Below this reflectance a pane's mirror is too faint for the copy of the scene to be worth its
 * taps: the back pane seen head-on mirrors a few percent, a side pane past the critical angle all.
 */
export const MIN_REFLECTANCE = 0.2;
/** From this reflectance up the copy is in full; above `MIN_REFLECTANCE` it eases in. */
export const FULL_REFLECTANCE = 0.35;
/**
 * Metres from the edge of the backdrop and the floor over which the copy fades out, so it is gone
 * by the time the mirrored ray leaves through the surface or a pane, where it has nothing to show.
 */
export const IN_TANK_FADE = 0.05;

function saturate(x: Node<'float'>): Node<'float'> {
  return max(min(x, 1), 0);
}

/** 1 inside the screen, falling linearly to 0 over `EDGE_FADE` towards and past its edge. */
export function screenEdgeFade(uv: Node<'vec2'>): Node<'float'> {
  const inner = min(min(uv.x, uv.y), min(uv.x.oneMinus(), uv.y.oneMinus()));
  return saturate(inner.div(EDGE_FADE));
}

/** 0 up to the first `AGREEMENT_FADE` cosine, rising linearly to 1 at the second. */
export function agreementFade(cosine: Node<'float'>): Node<'float'> {
  const [from, to] = AGREEMENT_FADE;
  return saturate(cosine.sub(from).div(to - from));
}

/**
 * For `point` on the water box: 1 on the backdrop and the floor further than `IN_TANK_FADE` from
 * any other face, falling linearly to 0 at the surface, the side panes and the front pane.
 */
export function inTankFade(
  point: Node<'vec3'>,
  boxMin: UniformNode<'vec3', Vector3>,
  boxMax: UniformNode<'vec3', Vector3>,
): Node<'float'> {
  const sides = min(point.x.sub(boxMin.x), boxMax.x.sub(point.x));
  const open = min(boxMax.y.sub(point.y), boxMax.z.sub(point.z));
  return saturate(min(sides, open).div(IN_TANK_FADE));
}

/**
 * How much of the copy a pane fragment takes: none on a face seen from outside the water
 * (`towardsWater` 0), and easing in from none at `MIN_REFLECTANCE` to all at `FULL_REFLECTANCE`.
 */
export function mirrorPresence(
  towardsWater: Node<'float'>,
  reflectance: Node<'float'>,
): Node<'float'> {
  const t = saturate(reflectance.sub(MIN_REFLECTANCE).div(FULL_REFLECTANCE - MIN_REFLECTANCE));
  return towardsWater.mul(t.mul(t).mul(t.mul(-2).add(3)));
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

type FrameTarget = RenderTarget | CanvasTarget;

/**
 * The copy of the frame the glass samples. Each target the scene is drawn into gets its own
 * full-size copy, freed with that target or else with the mirror.
 */
export class FrameCopy extends ViewportTextureNode {
  private readonly copies = new Map<FrameTarget, () => void>();

  override getTextureForReference(reference: FrameTarget | null = null): Texture {
    const texture = super.getTextureForReference(reference);
    const base = this.getBase();
    if (reference !== null && base instanceof FrameCopy) base.keep(reference, texture);
    return texture;
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    // `compileAsync` runs this too, and a copy then would only allocate one for the canvas that
    // the post pipeline never samples. ShadowNode skips its pre-compile render on the same flag.
    const renderer = frame.renderer;
    if (renderer !== null && '_isPreCompiling' in renderer && renderer._isPreCompiling === true) {
      return undefined;
    }
    return super.updateBefore(frame);
  }

  get copyCount(): number {
    return this.copies.size;
  }

  override dispose(): void {
    for (const release of [...this.copies.values()]) release();
    this.value.dispose();
    super.dispose();
  }

  private keep(reference: FrameTarget, texture: Texture): void {
    if (this.copies.has(reference)) return;
    const release = (): void => {
      unwatch();
      texture.dispose();
      this.copies.delete(reference);
    };
    const unwatch = watchDispose(reference, release);
    this.copies.set(reference, release);
  }
}

function watchDispose(
  target: {
    addEventListener(type: 'dispose', listener: () => void): void;
    removeEventListener(type: 'dispose', listener: () => void): void;
  },
  listener: () => void,
): () => void {
  target.addEventListener('dispose', listener);
  return () => target.removeEventListener('dispose', listener);
}

/**
 * A pane's mirror of the tank's contents taken from the scene drawn so far. The glass draws after
 * everything in the water, so a copy of the frame just before it holds the plants, decor and fish.
 * A plane mirror shows, at each fragment, what lies along the mirrored ray: this takes it to be
 * whatever the camera sees where that ray ends on the backdrop or the floor, with the water along
 * the camera's path swapped for the water along the mirrored one. That is exact where the two
 * lines of sight agree and only placed less faithfully where they part, so it fades to the traced
 * mirror there, off screen, and towards where the ray leaves through the surface or a pane.
 */
export class PaneMirror {
  readonly frame = new FrameCopy();

  constructor() {
    // The copy has one level; a mipmapped filter would make it incomplete on WebGL.
    this.frame.value.minFilter = LinearFilter;
  }

  /**
   * The radiance mirrored along `dir` from `origin`, the fragment on the pane, which leaves the
   * water at `end`: the copy blended over `fallback` by `presence` (see `mirrorPresence`) and the
   * fades. Where they reach 0 it is `fallback`, and the copy is not sampled.
   */
  radiance(
    medium: WaterMedium,
    origin: Node<'vec3'>,
    dir: Node<'vec3'>,
    end: Node<'vec3'>,
    presence: Node<'float'>,
    fallback: Node<'vec3'>,
  ): Node<'vec3'> {
    return Fn(() => {
      const result = vec3(fallback).toVar();
      const reach = presence.mul(inTankFade(end, medium.boxMin, medium.boxMax)).toVar();
      If(reach.greaterThan(0), () => {
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
        // The screen-edge fade reaches 0 before `view.z` does, so cutting what lies behind the
        // camera leaves no seam.
        const weight = reach
          .mul(screenEdgeFade(uv))
          .mul(agreementFade(agreement))
          .mul(step(view.z, 0));
        result.assign(mix(fallback, mirrored, weight));
      });
      return result;
    })();
  }

  dispose(): void {
    this.frame.dispose();
  }
}
