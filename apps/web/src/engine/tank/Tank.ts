import {
  BackSide,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  SrcColorFactor,
  Vector2,
  Vector3,
  ZeroFactor,
  type Material,
  type Node,
  type PerspectiveCamera,
  type PMREMNode,
  type Scene,
  type Texture,
  type TextureNode,
  type UniformNode,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  backgroundIntensity,
  cameraViewMatrix,
  color,
  cos,
  dot,
  float,
  frontFacing,
  Fn,
  If,
  max,
  min,
  mix,
  mrt,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  normalView,
  normalWorldGeometry,
  normalize,
  output,
  pmremTexture,
  positionViewDirection,
  positionWorld,
  pow,
  reflect,
  refract,
  saturate,
  select,
  smoothstep,
  step,
  time,
  transformNormalByViewMatrix,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BACKGROUND_TIERS } from '@aquarium/shared';
import type { InteriorLight } from '../water/interior';
import type { WaterMedium } from '../water/medium';
import { AIR_IOR, fresnelDielectric, WATER_IOR } from '../water/optics';
import {
  sameTank,
  STAND_HEIGHT,
  type TankDimensions,
  validateTank,
  waterBounds,
} from './dimensions';
import { createSubstrateGeometry, createSubstrateMaterial } from './substrate';
import { SurfaceReflection, UNREFLECTED_LAYER } from './surfaceReflection';

const GLASS_F0 = 0.04;
/** Ripples spread the room seen through Snell's window a little. */
const SURFACE_ROUGHNESS = 0.08;
const WATER_F0 = 0.02;
/**
 * Screen-UV shift of the mirror per unit of ripple slope: a slope tilts the reflected ray by twice
 * its angle, and the 40° camera spans about 0.73 in tan across the screen.
 */
const RIPPLE_MIRROR_SHIFT = 2 / 0.73;

/** Schlick Fresnel against the shading normal. */
function schlick(f0: number): Node<'float'> {
  const cosTheta = abs(dot(normalView, positionViewDirection)).clamp(0, 1);
  return pow(cosTheta.oneMinus(), 5)
    .mul(1 - f0)
    .add(f0);
}

function premultipliedBlend(material: Material): void {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.premultipliedAlpha = false;
}

/** Linear albedo of a diatom/green-algae film and of green spot algae (Coleochaete). */
const ALGAE_FILM = new Color(0.1, 0.13, 0.035);
const ALGAE_SPOT = new Color(0.035, 0.16, 0.025);
/** Irradiance on the glass relative to the medium's in-scatter radiance (4π sr over a cosine). */
const ALGAE_IRRADIANCE_GAIN = 4;

/**
 * Algae growing on the inside of the glass, below the waterline: a mottled film that thickens
 * with `amount` and, past about a third, hard green spots. Composited over the pane's
 * premultiplied output, so it occludes what is behind it.
 */
function overlayAlgae(
  pane: Node<'vec4'>,
  amount: UniformNode<'float', number>,
  medium: WaterMedium,
): Node<'vec4'> {
  return Fn(() => {
    const result = vec4(pane).toVar();
    If(amount.greaterThan(0), () => {
      const p = positionWorld;
      const onPane = vec2(p.x.add(p.z), p.y);
      const below = step(p.y, medium.boxMax.y).mul(step(medium.boxMin.y, p.y));
      const mottle = mx_fractal_noise_float(vec3(onPane.mul(7), 0.5), 3, 2, 0.5)
        .mul(0.5)
        .add(0.5);
      const film = smoothstep(
        amount.oneMinus().mul(0.8),
        amount.oneMinus().mul(0.8).add(0.35),
        mottle,
      ).mul(amount.mul(0.7).add(0.1));
      const spots = smoothstep(0.06, 0.11, mx_worley_noise_float(vec3(onPane.mul(45), 2.5), 1, 0))
        .oneMinus()
        .mul(smoothstep(0.3, 0.8, amount))
        .mul(step(0.35, mottle));
      const cover = saturate(film.add(spots)).mul(below).toVar();
      const albedo = mix(color(ALGAE_FILM), color(ALGAE_SPOT), saturate(spots));
      const lit = albedo
        .mul(medium.inScatterRadiance(medium.boxMax.y.sub(p.y)))
        .mul(ALGAE_IRRADIANCE_GAIN);
      result.assign(
        vec4(pane.rgb.mul(cover.oneMinus()).add(lit.mul(cover)), mix(pane.a, float(1), cover)),
      );
    });
    return result;
  })();
}

/** The poster's back: opaque black film, as on a real tank. */
const BACKING_ALBEDO = new Color(0.012, 0.012, 0.012);
/** Width over height of every background picture (PLAN 9.2). */
const POSTER_ASPECT = BACKGROUND_TIERS.high[0] / BACKGROUND_TIERS.high[1];
/** Mip bias that softens the picture a little, as if seen out of focus past the fish. */
const POSTER_DEFOCUS = 0.75;
/** Irradiance of the hood's beam on the backdrop relative to the surface: it only grazes it. */
const BACKDROP_GRAZE = 0.35;
/** Mirrored rays leaving the water this close to the back face end on the backdrop. */
const BACKDROP_TOLERANCE = 0.02;
const BACKDROP_GAP = 0.0005;
const UP = vec3(0, 1, 0);
const FORWARD = vec3(0, 0, 1);

/**
 * Hood irradiance at `depth` below the surface, as a fraction `share` of what reaches a level
 * surface there (the medium's hood in-scatter is the hood's light over 4π sr).
 */
function hoodIrradiance(medium: WaterMedium, depth: Node<'float'>, share: number): Node<'vec3'> {
  return medium
    .lightAtDepth(depth)
    .mul(medium.hoodInScatter)
    .mul(4 * share);
}

/** Linear albedo of the backdrop at a world point on or just off the back pane. */
type BackdropAlbedo = (p: Node<'vec3'>) => Node<'vec3'>;

/**
 * The share of the picture's width and height shown on a back pane of `d`'s length and height:
 * scaled to cover it and cropped about its centre, so a tank of any proportions shows no bars.
 */
export function posterSpan(d: TankDimensions): [number, number] {
  const paneAspect = d.length / d.height;
  return paneAspect >= POSTER_ASPECT
    ? [1, POSTER_ASPECT / paneAspect]
    : [paneAspect / POSTER_ASPECT, 1];
}

/**
 * The background picture across the back pane, which spans the tank's length and height. Its
 * placement is uniform, so a resize moves it without rebuilding a pipeline.
 */
export class Poster {
  /** The back pane's length and height. */
  readonly pane = uniform(new Vector2(1, 1));
  /** What `posterSpan` gives for the pane. */
  readonly span = uniform(new Vector2(1, 1));
  readonly albedo: BackdropAlbedo;

  constructor(map: TextureNode, d: TankDimensions) {
    this.fit(d);
    this.albedo = (p) => {
      const u = p.x.div(this.pane.x).mul(this.span.x).add(0.5);
      const v = p.y.div(this.pane.y).sub(0.5).mul(this.span.y).add(0.5);
      // KTX2 cannot be flipped on upload, so its first row, the top of the picture, is at v = 0.
      return map.sample(vec2(u, v.oneMinus())).bias(float(POSTER_DEFOCUS)).rgb;
    };
  }

  fit(d: TankDimensions): void {
    this.pane.value.set(d.length, d.height);
    this.span.value.set(...posterSpan(d));
  }
}

/**
 * Radiance of the inside of the backdrop at `p` on the back face of the water: grazed by the
 * hood, and lit by the light bouncing around the tank.
 */
function backdropRadiance(
  medium: WaterMedium,
  interior: InteriorLight,
  p: Node<'vec3'>,
  albedo: BackdropAlbedo,
): Node<'vec3'> {
  const inside = medium.clampInside(p);
  const hood = hoodIrradiance(medium, medium.boxMax.y.sub(p.y), BACKDROP_GRAZE);
  return hood.add(interior.ambientAt(inside, FORWARD)).mul(albedo(p));
}

/**
 * What a side pane mirrors below the water is the substrate, which its shader cannot see: a
 * level patch of it under the hood stands in for it, rather than the room's floor.
 */
function mirroredSubstrate(
  medium: WaterMedium,
  interior: InteriorLight,
  p: Node<'vec3'>,
): Node<'vec3'> {
  const inside = medium.clampInside(p);
  const hood = hoodIrradiance(medium, medium.boxMax.y.sub(medium.boxMin.y), 1);
  return hood.add(interior.ambientAt(inside, UP)).mul(interior.substrateAlbedo);
}

/**
 * Radiance reaching the fragment, a point in the water, along `dir` from where that ray leaves the
 * water box: the backdrop, a level patch of substrate on the floor, or the room seen through the
 * glass (`room`), dimmed and in-scattered over the way. No object in the water is drawn.
 */
function waterAlongRay(
  medium: WaterMedium,
  interior: InteriorLight,
  dir: Node<'vec3'>,
  room: PMREMNode,
  backdrop: BackdropAlbedo,
): Node<'vec3'> {
  const exitDistance = medium.exitDistance(positionWorld, dir).toVar();
  const across = medium.transmittance(exitDistance).toVar();
  const exitPoint = positionWorld.add(dir.mul(exitDistance)).toVar();
  const onBackdrop = step(exitPoint.z, medium.boxMin.z.add(BACKDROP_TOLERANCE));
  const onFloor = step(exitPoint.y, medium.boxMin.y.add(BACKDROP_TOLERANCE));
  const inTank = mix(
    backdropRadiance(medium, interior, exitPoint, backdrop),
    mirroredSubstrate(medium, interior, exitPoint),
    onFloor,
  );
  const beyond = mix(room.mul(backgroundIntensity), inTank, max(onBackdrop, onFloor));
  const midDepth = medium.boxMax.y.sub(positionWorld.y.add(exitPoint.y).mul(0.5));
  return medium.inScatter(across, midDepth).add(beyond.mul(across));
}

/**
 * The faces of a pane only reflect: diffuse is black and the output is premultiplied, so the
 * reflection adds on top while the scene behind is kept by (1 - F). A face towards the water is
 * seen through it, where the parallel plate acts as a water-air boundary: past the critical angle
 * (48.6°) it reflects totally, which is why side panes look silvered from the front. What they
 * mirror is the water across the tank and the room beyond it, dimmed by that path.
 */
function createGlassFaceMaterial(
  medium: WaterMedium,
  interior: InteriorLight,
  algae: UniformNode<'float', number>,
  sky: Texture,
  backdrop: BackdropAlbedo,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.03, metalness: 0 });
  material.name = 'glass-face';
  material.colorNode = vec3(0);
  material.opacityNode = schlick(GLASS_F0);
  premultipliedBlend(material);
  material.fog = false;

  const centre = medium.boxMin.add(medium.boxMax).mul(0.5);
  const towardsWater = step(dot(normalWorldGeometry, positionWorld.sub(centre)), 0);
  const inWater = medium.waterRayDirection().toVar();
  const cosWater = abs(dot(inWater, normalWorldGeometry));
  const reflectance = fresnelDielectric(cosWater, WATER_IOR / AIR_IOR).toVar();
  const mirrored = reflect(inWater, normalWorldGeometry).toVar();
  const skyNode = pmremTexture(sky, mirrored, float(SURFACE_ROUGHNESS));
  const mirroredScene = waterAlongRay(medium, interior, mirrored, skyNode, backdrop);
  const inner = vec4(mirroredScene.mul(reflectance), reflectance);
  const pane = mix(output, inner, towardsWater);
  material.outputNode = medium.applyPremultiplied(overlayAlgae(pane, algae, medium));
  return material;
}

/** Light travelling along the pane gives float glass its green edge. */
function createGlassEdgeMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    color: new Color(0x6fa894),
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    opacity: 0.75,
  });
  material.name = 'glass-edge';
  material.emissive = new Color(0x0f2a20);
  return material;
}

const FACE_GROUPS = { x: [0, 1], y: [2, 3], z: [4, 5] } as const;

/** Keeps only the index ranges of the given BoxGeometry groups (ordered +x, -x, +y, -y, +z, -z). */
function boxGroups(box: BoxGeometry, groups: readonly number[]): BufferGeometry {
  const index = box.getIndex();
  if (index === null) throw new Error('Tank: BoxGeometry is expected to be indexed');
  const kept: number[] = [];
  for (const g of groups) {
    const group = box.groups[g];
    if (!group) throw new Error(`Tank: BoxGeometry has no group ${g}`);
    for (let i = group.start; i < group.start + group.count; i++) kept.push(index.getX(i));
  }
  const subset = box.clone();
  subset.clearGroups();
  subset.setIndex(kept);
  return subset;
}

/** Calm-surface ripples from the filter outflow: four travelling waves, analytic slope. */
function rippleNormalWorld(amplitude: Node<'float'>): Node<'vec3'> {
  const waves: [number, number, number, number][] = [
    [0.8, 0.6, 31, 1.7],
    [-0.5, 0.86, 47, 2.3],
    [0.95, -0.3, 73, 3.1],
    [0.2, 0.98, 113, 4.2],
  ];
  let slopeX: Node<'float'> = float(0);
  let slopeZ: Node<'float'> = float(0);
  for (const [dx, dz, k, omega] of waves) {
    const phase = positionWorld.x
      .mul(dx * k)
      .add(positionWorld.z.mul(dz * k))
      .sub(time.mul(omega));
    const weight = cos(phase).mul(amplitude).div(Math.sqrt(k));
    slopeX = slopeX.add(weight.mul(dx));
    slopeZ = slopeZ.add(weight.mul(dz));
  }
  return normalize(vec3(slopeX.negate(), 1, slopeZ.negate()));
}

interface SurfaceUnderside {
  material: MeshBasicNodeMaterial;
  /** The rippled surface normal, in world space. */
  normal: Node<'vec3'>;
  /** The output with `mirror` as what total internal reflection shows, else the traced walls. */
  output(mirror?: Node<'vec3'>): Node<'vec4'>;
}

/**
 * The underside of the surface seen from the water: inside Snell's window (a 97° cone) the room
 * shows through, compressed towards the rim; outside it total internal reflection mirrors the
 * tank. Without a reflection of the scene the mirrored ray is traced to the walls and floor, so the
 * mirror still shades from the long hazy paths at the rim to the short ones onto the sand.
 */
function createSurfaceUnderside(
  medium: WaterMedium,
  interior: InteriorLight,
  normal: Node<'vec3'>,
  sky: Texture,
  backdrop: BackdropAlbedo,
): SurfaceUnderside {
  const material = new MeshBasicNodeMaterial();
  material.name = 'water-surface-underside';
  material.side = BackSide;
  material.fog = false;
  const view = medium.waterRayDirection().toVar();
  const reflectance = fresnelDielectric(abs(dot(view, normal)), WATER_IOR / AIR_IOR).toVar();
  // Past the critical angle refract() returns zero, where the reflectance is 1 anyway.
  const toRoom = refract(view, normal.negate(), WATER_IOR / AIR_IOR).add(vec3(0, 1e-4, 0));
  const skyNode = pmremTexture(sky, toRoom, float(SURFACE_ROUGHNESS));
  const room = skyNode.mul(backgroundIntensity);
  const bounced = reflect(view, normal);
  // A ripple can tip a grazing ray back up; it still has to go down into the water.
  const mirrored = normalize(vec3(bounced.x, min(bounced.y, -1e-3), bounced.z)).toVar();
  const mirroredSky = pmremTexture(sky, mirrored, float(SURFACE_ROUGHNESS));
  const traced = waterAlongRay(medium, interior, mirrored, mirroredSky, backdrop);
  const output = (mirror: Node<'vec3'> = traced): Node<'vec4'> =>
    medium.applyPremultiplied(vec4(mix(room, mirror, reflectance), 1));
  material.outputNode = output();
  return { material, normal, output };
}

/**
 * The background picture on the back pane, outside the water and its caustics. It hides the
 * room behind the tank, and seen from the front it is tinted once by the water volume drawn
 * over it. The camera can orbit behind the tank, where the film's black back shows, lit by the
 * room.
 */
function createBackdropMaterial(
  medium: WaterMedium,
  interior: InteriorLight,
  albedo: BackdropAlbedo,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ side: DoubleSide });
  material.name = 'backdrop';
  material.fog = false;
  const back = interior.ambientAt(positionWorld, FORWARD.negate()).mul(color(BACKING_ALBEDO));
  material.colorNode = select(
    frontFacing,
    backdropRadiance(medium, interior, positionWorld, albedo),
    back,
  );
  return material;
}

/** Every pane as a box: the reflective faces and the green cut edges, each merged into one geometry. */
function glassGeometries(d: TankDimensions): [BufferGeometry, BufferGeometry] {
  const { length: l, depth: w, height: h, glass: g } = d;
  const panes: {
    size: [number, number, number];
    at: [number, number, number];
    thin: 'x' | 'y' | 'z';
  }[] = [
    { size: [l, h, g], at: [0, h / 2, w / 2 - g / 2], thin: 'z' },
    { size: [l, h, g], at: [0, h / 2, -w / 2 + g / 2], thin: 'z' },
    { size: [g, h, w - 2 * g], at: [-l / 2 + g / 2, h / 2, 0], thin: 'x' },
    { size: [g, h, w - 2 * g], at: [l / 2 - g / 2, h / 2, 0], thin: 'x' },
    { size: [l - 2 * g, g, w - 2 * g], at: [0, g / 2, 0], thin: 'y' },
  ];
  const faces: BufferGeometry[] = [];
  const edges: BufferGeometry[] = [];
  for (const pane of panes) {
    const box = new BoxGeometry(...pane.size).translate(...pane.at);
    const faceGroups: readonly number[] = FACE_GROUPS[pane.thin];
    faces.push(boxGroups(box, faceGroups));
    edges.push(
      boxGroups(
        box,
        [0, 1, 2, 3, 4, 5].filter((i) => !faceGroups.includes(i)),
      ),
    );
    box.dispose();
  }
  const merge = (parts: BufferGeometry[]): BufferGeometry => {
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    return merged;
  };
  return [merge(faces), merge(edges)];
}

/** Stands in for a mesh's geometry until `fit` builds the real one. */
const UNBUILT = new BufferGeometry();

export class Tank {
  readonly group = new Group();
  /** The water box. A resize changes it in place, so whoever holds it follows the tank. */
  readonly waterBounds = new Box3();
  readonly substrate: Mesh;
  readonly rippleAmplitude = uniform(0.12);
  /** 0 clean glass .. 1 neglected for weeks. */
  readonly algae = uniform(0);
  private size: Readonly<TankDimensions>;
  private readonly disposables: { dispose(): void }[] = [];
  /** The geometries of the current size, replaced together on a resize. */
  private geometries: BufferGeometry[] = [];
  /** Blended materials that multiply, and the velocity each must write to leave it unchanged. */
  private readonly blended: [NodeMaterial, Node<'vec4'>][] = [];
  private readonly glassFaces: Mesh;
  private readonly glassEdges: Mesh;
  private readonly backdrop: Mesh;
  private readonly volume: readonly Mesh[];
  private readonly surface: Mesh;
  private readonly stand: Mesh;
  private readonly surfaceBox = new Box3();
  private readonly reflection: SurfaceReflection;
  private readonly underside: SurfaceUnderside;
  private readonly undersideMesh: Mesh;
  /** The background picture; `resize` refits it to the new back pane. */
  readonly poster: Poster;

  /**
   * `sky` is the room environment, seen from below through Snell's window. `background` is the
   * picture behind the back pane; its texture may change at any time.
   */
  constructor(
    dimensions: TankDimensions,
    medium: WaterMedium,
    sky: Texture,
    interior: InteriorLight,
    background: TextureNode,
  ) {
    validateTank(dimensions);
    this.size = { ...dimensions };
    this.poster = new Poster(background, dimensions);
    this.group.name = 'tank';
    waterBounds(dimensions, this.waterBounds);

    this.substrate = this.addMesh('substrate', createSubstrateMaterial());
    this.substrate.receiveShadow = true;
    this.substrate.castShadow = true;

    this.glassFaces = this.addMesh(
      'glass-faces',
      createGlassFaceMaterial(medium, interior, this.algae, sky, this.poster.albedo),
    );
    this.glassEdges = this.addMesh('glass-edges', createGlassEdgeMaterial());
    for (const mesh of [this.glassFaces, this.glassEdges]) mesh.renderOrder = 2;
    // The faces trace the eye's ray as refracted into the water where it meets the box, which
    // for the mirrored camera above the surface is the wrong boundary.
    this.glassFaces.layers.set(UNREFLECTED_LAYER);

    this.backdrop = this.addMesh(
      'backdrop',
      createBackdropMaterial(medium, interior, this.poster.albedo),
    );
    this.volume = this.addWaterVolume(medium);
    [this.surface, this.underside, this.undersideMesh] = this.addWaterSurface(
      medium,
      sky,
      interior,
    );
    const standMaterial = new MeshStandardNodeMaterial({
      color: new Color(0x1d1c1b),
      roughness: 0.55,
    });
    standMaterial.name = 'stand';
    this.stand = this.addMesh('stand', standMaterial);
    this.stand.receiveShadow = true;

    this.reflection = new SurfaceReflection(this.surfaceBox);
    this.disposables.push(this.reflection);
    this.fit();
  }

  get dimensions(): Readonly<TankDimensions> {
    return this.size;
  }

  /**
   * Rebuilds the glass, sand, water and stand for `dimensions`. Only geometry changes: every
   * material reads the water box from the medium's uniforms and the poster's placement from its
   * own, so no pipeline is rebuilt. Returns
   * whether anything changed.
   */
  resize(dimensions: TankDimensions): boolean {
    validateTank(dimensions);
    if (sameTank(dimensions, this.size)) return false;
    this.size = { ...dimensions };
    waterBounds(dimensions, this.waterBounds);
    this.fit();
    return true;
  }

  /**
   * Total internal reflection under the surface shows the scene itself, drawn again at
   * `resolutionScale` of the drawing buffer; 0 traces the walls in the shader instead.
   */
  setSurfaceReflection(resolutionScale: number): void {
    const wasEnabled = this.reflection.enabled;
    this.reflection.setResolutionScale(resolutionScale);
    if (this.reflection.enabled === wasEnabled) return;
    const { material, output, normal } = this.underside;
    material.outputNode = this.reflection.enabled
      ? output(this.reflection.sample(normal.xz.mul(RIPPLE_MIRROR_SHIFT)).rgb)
      : output();
    material.needsUpdate = true;
  }

  get surfaceReflection(): boolean {
    return this.reflection.enabled;
  }

  /**
   * Builds the pipelines the surface reflection adds: its own pass, and the underside drawn from
   * `camera` with the reflection in it.
   */
  async compileSurfaceReflection(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
  ): Promise<void> {
    if (!this.reflection.enabled) return;
    await this.reflection.compile(renderer, scene, camera);
    await renderer.compileAsync(this.undersideMesh, camera, scene);
  }

  /**
   * Draws the surface reflection for this frame's camera; call it before the scene is drawn.
   * Returns whether it drew.
   */
  renderSurfaceReflection(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
  ): boolean {
    return this.reflection.render(renderer, scene, camera);
  }

  /**
   * Under TRAA the scene pass has a velocity attachment that blends as each material does. The
   * pass keeps it under the usual blends by itself (see `temporalOutputs`); a multiplying pass
   * keeps it by writing one.
   */
  setVelocityPassthrough(on: boolean): void {
    for (const [material, keep] of this.blended) {
      material.mrtNode = on ? mrt({ velocity: keep }) : null;
      material.needsUpdate = true;
    }
  }

  setAlgae(amount: number): void {
    if (!(amount >= 0 && amount <= 1)) {
      throw new RangeError(`Tank.setAlgae: amount must be within [0, 1], got ${amount}`);
    }
    this.algae.value = amount;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries = [];
    this.group.removeFromParent();
  }

  private addMesh(name: string, material: Material): Mesh {
    this.disposables.push(material);
    const mesh = new Mesh(UNBUILT, material);
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  private build<G extends BufferGeometry>(geometry: G): G {
    this.geometries.push(geometry);
    return geometry;
  }

  /** Gives every mesh its geometry and place for the current size. */
  private fit(): void {
    const d = this.size;
    const old = this.geometries;
    this.geometries = [];

    this.substrate.geometry = this.build(createSubstrateGeometry(d));
    const [faces, edges] = glassGeometries(d);
    this.glassFaces.geometry = this.build(faces);
    this.glassEdges.geometry = this.build(edges);

    this.backdrop.geometry = this.build(new PlaneGeometry(d.length, d.height));
    this.backdrop.position.set(0, d.height / 2, -d.depth / 2 - BACKDROP_GAP);
    this.poster.fit(d);

    const bounds = this.waterBounds;
    const size = bounds.getSize(new Vector3());
    const centre = bounds.getCenter(new Vector3());
    const box = this.build(new BoxGeometry(size.x, size.y, size.z));
    for (const mesh of this.volume) {
      mesh.geometry = box;
      mesh.position.copy(centre);
    }

    const top = bounds.max.y;
    const plane = this.build(new PlaneGeometry(size.x, size.z));
    for (const mesh of [this.surface, this.undersideMesh]) {
      mesh.geometry = plane;
      mesh.position.set(0, top, 0);
    }
    this.surfaceBox.min.set(bounds.min.x, top, bounds.min.z);
    this.surfaceBox.max.set(bounds.max.x, top, bounds.max.z);

    this.stand.geometry = this.build(
      new BoxGeometry(d.length + 0.04, STAND_HEIGHT, d.depth + 0.04),
    );
    this.stand.position.set(0, -STAND_HEIGHT / 2, 0);

    for (const g of old) g.dispose();
  }

  /**
   * Two passes over the far faces of the water box handle whatever is seen through the
   * water without an object in it (the room behind): first multiply by the spectral
   * transmittance, then add the in-scattered light. Objects inside the water occlude
   * these faces and are fogged by the scene fog node instead.
   */
  private addWaterVolume(medium: WaterMedium): Mesh[] {
    const absorb = new MeshBasicNodeMaterial();
    absorb.name = 'water-volume-absorb';
    absorb.side = BackSide;
    absorb.transparent = true;
    absorb.depthWrite = false;
    absorb.fog = false;
    absorb.blending = CustomBlending;
    absorb.blendSrc = ZeroFactor;
    absorb.blendDst = SrcColorFactor;
    absorb.blendSrcAlpha = ZeroFactor;
    absorb.blendDstAlpha = OneFactor;
    absorb.outputNode = vec4(medium.volumeTransmittance(), 1);
    this.blended.push([absorb, vec4(1)]);

    const scatter = new MeshBasicNodeMaterial();
    scatter.name = 'water-volume-scatter';
    scatter.side = BackSide;
    scatter.transparent = true;
    scatter.depthWrite = false;
    scatter.fog = false;
    scatter.blending = CustomBlending;
    scatter.blendSrc = OneFactor;
    scatter.blendDst = OneFactor;
    scatter.blendSrcAlpha = ZeroFactor;
    scatter.blendDstAlpha = OneFactor;
    scatter.outputNode = vec4(medium.volumeInScatter(), 0);

    return [absorb, scatter].map((material, i) => {
      const mesh = this.addMesh(material.name, material);
      mesh.renderOrder = i - 2;
      return mesh;
    });
  }

  private addWaterSurface(
    medium: WaterMedium,
    sky: Texture,
    interior: InteriorLight,
  ): [Mesh, SurfaceUnderside, Mesh] {
    const material = new MeshPhysicalNodeMaterial({ roughness: 0.02, metalness: 0, ior: 1.333 });
    material.name = 'water-surface';
    material.colorNode = vec3(0);
    const normal = rippleNormalWorld(this.rippleAmplitude.mul(0.01));
    material.normalNode = transformNormalByViewMatrix(normal, cameraViewMatrix);
    material.opacityNode = schlick(WATER_F0);
    premultipliedBlend(material);
    material.fog = false;
    material.outputNode = medium.applyPremultiplied(output);

    const below = createSurfaceUnderside(medium, interior, normal, sky, this.poster.albedo);
    const meshes = [
      this.addMesh('water-surface', material),
      this.addMesh('water-surface-underside', below.material),
    ];
    for (const mesh of meshes) {
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1;
      mesh.layers.set(UNREFLECTED_LAYER);
    }
    const [surface, underside] = meshes as [Mesh, Mesh];
    return [surface, below, underside];
  }
}
