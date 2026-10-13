import {
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  Vector3,
  type Node,
  type Renderer,
} from 'three/webgpu';
import {
  dot,
  exp,
  float,
  floor,
  fract,
  Fn,
  If,
  length,
  max,
  min,
  mod,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { CausticMethod } from '../quality/tiers';
import type { WaterMedium } from './medium';

const TAU = Math.PI * 2;
const FEATURE_WANDER = 0.38;
const EDGE_WIDTH = 0.35;
const EDGE_POWER = 4;
/**
 * 1 / mean of the shaped edge pattern, measured by Monte Carlo over cell position and
 * phase. Scaling by it keeps the average light reaching the substrate unchanged:
 * caustics only redistribute energy.
 */
const PATTERN_GAIN = 6.25;
const BAKE_PERIOD_CELLS = 8;
const BAKE_SIZE = 512;
const DISPERSION = 0.015;

const METHOD_ID = { texture: 0, single: 1, layered: 2, dispersion: 3 } as const;

const hash22 = (p: Node<'vec2'>): Node<'vec2'> =>
  fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453));

/**
 * Animated Voronoi F2-F1 distance: zero on cell borders, where refracted rays from a
 * rippled surface converge into the bright caustic network. With `period` set, cell ids
 * wrap so the pattern tiles.
 */
function cellEdge(p: Node<'vec2'>, t: Node<'float'>, period: number | null): Node<'float'> {
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  const f1 = float(8).toVar();
  const f2 = float(8).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const offset = vec2(i, j);
      const id = period === null ? cell.add(offset) : mod(cell.add(offset).add(period), period);
      const h = hash22(id);
      const wander = vec2(sin(t.add(h.x.mul(TAU))), sin(t.mul(1.13).add(h.y.mul(TAU))));
      const feature = offset.add(0.5).add(wander.mul(FEATURE_WANDER));
      const d = length(feature.sub(f)).toVar();
      f2.assign(min(f2, max(f1, d)));
      f1.assign(min(f1, d));
    }
  }
  return f2.sub(f1);
}

const shapeEdge = (e: Node<'float'>): Node<'float'> =>
  pow(saturate(e.div(EDGE_WIDTH).oneMinus()), EDGE_POWER);

const layeredPattern = (p: Node<'vec2'>, t: Node<'float'>): Node<'float'> => {
  const near = shapeEdge(cellEdge(p, t, null));
  const far = shapeEdge(cellEdge(p.mul(1.7).add(vec2(13.1, 7.3)), t.mul(1.3), null));
  return near.mul(0.6).add(far.mul(0.4));
};

export function causticMethodId(method: CausticMethod, layers: 1 | 2): number {
  if (method === 'texture') return METHOD_ID.texture;
  if (method === 'procedural-dispersion') return METHOD_ID.dispersion;
  return layers === 2 ? METHOD_ID.layered : METHOD_ID.single;
}

/**
 * Caustics projected from the water surface along the hood light's direction. They are
 * applied as the light's colour node, so every lit surface under water (substrate, decor,
 * fish) receives them, and the light's shadow map masks them.
 */
export class Caustics {
  readonly strength = uniform(0.75);
  readonly cellsPerMetre = uniform(13);
  readonly speed = uniform(0.55);
  readonly method = uniform(METHOD_ID.layered, 'int');
  /** Unit vector from the scene towards the light. */
  readonly lightDirection = uniform(new Vector3(0, 1, 0));
  readonly lightRadiance = uniform(new Color(1, 1, 1));

  private readonly bakeTarget = new RenderTarget(BAKE_SIZE, BAKE_SIZE, {
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    depthBuffer: false,
  });
  private baked = false;

  constructor(private readonly medium: WaterMedium) {}

  setMethod(method: CausticMethod, layers: 1 | 2): void {
    if (method === 'texture' && !this.baked) {
      throw new Error('Caustics: call bake() before selecting the texture method');
    }
    this.method.value = causticMethodId(method, layers);
  }

  /** Renders one tileable frame of the procedural pattern for the low tier. */
  bake(renderer: Renderer): void {
    const material = new NodeMaterial();
    material.fragmentNode = Fn(() => {
      const edge = cellEdge(uv().mul(BAKE_PERIOD_CELLS), float(0), BAKE_PERIOD_CELLS);
      return vec4(vec3(shapeEdge(edge)), 1);
    })();
    const quad = new QuadMesh(material);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.bakeTarget);
    quad.render(renderer);
    renderer.setRenderTarget(previous);
    material.dispose();
    this.baked = true;
  }

  dispose(): void {
    this.bakeTarget.dispose();
  }

  /**
   * The baked pattern with unit mean at a surface point (metres), for effects that need the
   * caustic shape but not its animation detail. Sampled at an explicit level, so it may be
   * called from non-uniform control flow.
   */
  bakedAt(surfacePoint: Node<'vec2'>, scale: number): Node<'float'> {
    const cells = surfacePoint.mul(this.cellsPerMetre.mul(scale / BAKE_PERIOD_CELLS));
    const drift = vec2(0.021, 0.013).mul(time.mul(this.speed));
    return texture(this.bakeTarget.texture, cells.add(drift)).level(float(1)).r.mul(PATTERN_GAIN);
  }

  /**
   * The hood's light reaching `p` under water: spread and absorption on the slant path down from
   * the surface. Outside the water it is the hood's radiance itself.
   */
  private reach(p: Node<'vec3'>) {
    const { medium } = this;
    const depth = medium.boxMax.y.sub(p.y).toVar();
    const inWater = medium.submerged(p).toVar();
    const cosLight = max(this.lightDirection.y, 0.2);
    const slant = depth.div(cosLight).toVar();
    const transmittance = exp(medium.extinction().mul(slant.mul(inWater)).negate());
    const light = transmittance.mul(medium.hoodSpread(depth.mul(inWater))).mul(this.lightRadiance);
    return { depth, inWater, slant, light };
  }

  /** The hood's light at `p` without the caustic pattern, for effects shaded by hand. */
  hoodLight(p: Node<'vec3'> = positionWorld): Node<'vec3'> {
    return Fn(() => this.reach(p).light)();
  }

  /** Colour node for the hood light: radiance x spread x surface-to-point transmittance x caustics. */
  lightColorNode(): Node<'vec3'> {
    return Fn(() => {
      const p = positionWorld;
      const { depth, inWater, slant, light } = this.reach(p);
      const surfacePoint = p.xz.add(this.lightDirection.xz.mul(slant));
      const q = surfacePoint.mul(this.cellsPerMetre).toVar();
      const t = time.mul(this.speed).toVar();

      const tiled = q.div(BAKE_PERIOD_CELLS);
      const bakedA = texture(this.bakeTarget.texture, tiled.add(vec2(0.021, 0.013).mul(t))).r;
      const bakedB = texture(
        this.bakeTarget.texture,
        tiled.mul(0.73).add(vec2(-0.011, 0.019).mul(t)).add(0.37),
      ).r;
      const bakedPattern = bakedA.add(bakedB).mul(0.5).toVar();

      const pattern = vec3(1).toVar();
      If(this.method.equal(METHOD_ID.texture), () => {
        pattern.assign(vec3(bakedPattern));
      })
        .ElseIf(this.method.equal(METHOD_ID.single), () => {
          pattern.assign(vec3(shapeEdge(cellEdge(q, t, null))));
        })
        .ElseIf(this.method.equal(METHOD_ID.layered), () => {
          pattern.assign(vec3(layeredPattern(q, t)));
        })
        .Else(() => {
          pattern.assign(
            vec3(
              layeredPattern(q.mul(1 - DISPERSION), t),
              layeredPattern(q, t),
              layeredPattern(q.mul(1 + DISPERSION), t),
            ),
          );
        });

      const formed = smoothstep(0, 0.06, depth);
      const amount = this.strength.mul(formed).mul(inWater);
      const caustic = max(pattern.mul(PATTERN_GAIN).sub(1).mul(amount).add(1), 0);
      return caustic.mul(light);
    })();
  }
}
