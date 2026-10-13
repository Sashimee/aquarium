import {
  BackSide,
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
  Vector3,
  ZeroFactor,
  type Box3,
  type Material,
  type Node,
  type PMREMNode,
  type Texture,
  type UniformNode,
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
import type { InteriorLight } from '../water/interior';
import type { WaterMedium } from '../water/medium';
import { AIR_IOR, fresnelDielectric, WATER_IOR } from '../water/optics';
import { type TankDimensions, validateTank, waterBounds } from './dimensions';
import { createSubstrateGeometry, createSubstrateMaterial } from './substrate';

const GLASS_F0 = 0.04;
/** Ripples spread the room seen through Snell's window a little. */
const SURFACE_ROUGHNESS = 0.08;
const WATER_F0 = 0.02;

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
      const spots = smoothstep(0.11, 0.06, mx_worley_noise_float(vec3(onPane.mul(45), 2.5), 1, 0))
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

/** Linear albedo of the dark blue backdrop film stuck to the outside of the back pane. */
const BACKDROP_ALBEDO = new Color(0.01, 0.025, 0.08);
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

/**
 * Radiance of the inside of the backdrop at `p` on the back face of the water: grazed by the
 * hood, and lit by the light bouncing around the tank.
 */
function backdropRadiance(
  medium: WaterMedium,
  interior: InteriorLight,
  p: Node<'vec3'>,
): Node<'vec3'> {
  const inside = medium.clampInside(p);
  const hood = hoodIrradiance(medium, medium.boxMax.y.sub(p.y), BACKDROP_GRAZE);
  return hood.add(interior.ambientAt(inside, FORWARD)).mul(color(BACKDROP_ALBEDO));
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
 * The faces of a pane only reflect: diffuse is black and the output is premultiplied, so the
 * reflection adds on top while the scene behind is kept by (1 - F). A face towards the water is
 * seen through it, where the parallel plate acts as a water-air boundary: past the critical angle
 * (48.6°) it reflects totally, which is why side panes look silvered from the front. What they
 * mirror is the water across the tank and the room beyond it, dimmed by that path.
 */
function createGlassFaceMaterial(
  medium: WaterMedium,
  interior: InteriorLight,
  centre: Vector3,
  algae: UniformNode<'float', number>,
  sky: Texture,
): { material: MeshStandardNodeMaterial; skyNode: PMREMNode } {
  const material = new MeshStandardNodeMaterial({ roughness: 0.03, metalness: 0 });
  material.name = 'glass-face';
  material.colorNode = vec3(0);
  material.opacityNode = schlick(GLASS_F0);
  premultipliedBlend(material);
  material.fog = false;

  const towardsWater = step(dot(normalWorldGeometry, positionWorld.sub(vec3(centre))), 0);
  const inWater = medium.waterRayDirection().toVar();
  const cosWater = abs(dot(inWater, normalWorldGeometry));
  const reflectance = fresnelDielectric(cosWater, WATER_IOR / AIR_IOR).toVar();
  const mirrored = reflect(inWater, normalWorldGeometry).toVar();
  const exitDistance = medium.exitDistance(positionWorld, mirrored).toVar();
  const across = medium.transmittance(exitDistance).toVar();
  const exitPoint = positionWorld.add(mirrored.mul(exitDistance)).toVar();
  const onBackdrop = step(exitPoint.z, medium.boxMin.z.add(BACKDROP_TOLERANCE));
  const onFloor = step(exitPoint.y, medium.boxMin.y.add(BACKDROP_TOLERANCE));
  const skyNode = pmremTexture(sky, mirrored, float(SURFACE_ROUGHNESS));
  const inTank = mix(
    backdropRadiance(medium, interior, exitPoint),
    mirroredSubstrate(medium, interior, exitPoint),
    onFloor,
  );
  const beyond = mix(skyNode.mul(backgroundIntensity), inTank, max(onBackdrop, onFloor));
  const midDepth = medium.boxMax.y.sub(positionWorld.y.add(exitPoint.y).mul(0.5));
  const mirroredScene = medium.inScatter(across, midDepth).add(beyond.mul(across));
  const inner = vec4(mirroredScene.mul(reflectance), reflectance);
  const pane = mix(output, inner, towardsWater);
  material.outputNode = medium.applyPremultiplied(overlayAlgae(pane, algae, medium));
  return { material, skyNode };
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

/**
 * The underside of the surface seen from the water: inside Snell's window (a 97° cone) the room
 * shows through, compressed towards the rim; outside it total internal reflection mirrors the
 * water back.
 */
function createSurfaceUndersideMaterial(
  medium: WaterMedium,
  normal: Node<'vec3'>,
  sky: Texture,
): { material: MeshBasicNodeMaterial; skyNode: PMREMNode } {
  const material = new MeshBasicNodeMaterial();
  material.name = 'water-surface-underside';
  material.side = BackSide;
  material.fog = false;
  const view = medium.waterRayDirection().toVar();
  const reflectance = fresnelDielectric(abs(dot(view, normal)), WATER_IOR / AIR_IOR).toVar();
  const mirroredWater = medium.inScatter(vec3(0));
  // Past the critical angle refract() returns zero, where the reflectance is 1 anyway.
  const toRoom = refract(view, normal.negate(), WATER_IOR / AIR_IOR).add(vec3(0, 1e-4, 0));
  const skyNode = pmremTexture(sky, toRoom, float(SURFACE_ROUGHNESS));
  const room = skyNode.mul(backgroundIntensity);
  material.outputNode = medium.applyPremultiplied(vec4(mix(room, mirroredWater, reflectance), 1));
  return { material, skyNode };
}

export class Tank {
  readonly group = new Group();
  readonly waterBounds: Box3;
  readonly substrate: Mesh;
  readonly rippleAmplitude = uniform(0.12);
  /** 0 clean glass .. 1 neglected for weeks. */
  readonly algae = uniform(0);
  private readonly skyNodes: PMREMNode[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  /** Blended materials and the velocity each must write to leave the attachment unchanged. */
  private readonly blended: [NodeMaterial, Node<'vec4'>][] = [];

  /** `sky` is the room environment, seen from below through Snell's window. */
  constructor(
    readonly dimensions: TankDimensions,
    medium: WaterMedium,
    sky: Texture,
    interior: InteriorLight,
  ) {
    validateTank(dimensions);
    this.group.name = 'tank';
    this.waterBounds = waterBounds(dimensions);

    this.substrate = this.track(
      new Mesh(createSubstrateGeometry(dimensions), createSubstrateMaterial()),
    );
    this.substrate.name = 'substrate';
    this.substrate.receiveShadow = true;
    this.substrate.castShadow = true;
    this.group.add(this.substrate);

    this.addGlass(medium, sky, interior);
    this.addBackdrop(medium, interior);
    this.addWaterVolume(medium);
    this.addWaterSurface(medium, sky);
    this.addStand();
  }

  setSky(texture: Texture): void {
    for (const node of this.skyNodes) node.value = texture;
  }

  /**
   * Under TRAA the scene pass has a velocity attachment, and blending applies to it as well:
   * these outputs make every blended pass leave the velocity the opaque scene wrote.
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
    this.group.removeFromParent();
  }

  private track(mesh: Mesh): Mesh {
    this.disposables.push(mesh.geometry);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) if (!this.disposables.includes(m)) this.disposables.push(m);
    return mesh;
  }

  /** All panes share two draws: the reflective faces and the green cut edges. */
  private addGlass(medium: WaterMedium, sky: Texture, interior: InteriorLight): void {
    const { length: l, depth: d, height: h, glass: g } = this.dimensions;
    const panes: {
      size: [number, number, number];
      at: [number, number, number];
      thin: 'x' | 'y' | 'z';
    }[] = [
      { size: [l, h, g], at: [0, h / 2, d / 2 - g / 2], thin: 'z' },
      { size: [l, h, g], at: [0, h / 2, -d / 2 + g / 2], thin: 'z' },
      { size: [g, h, d - 2 * g], at: [-l / 2 + g / 2, h / 2, 0], thin: 'x' },
      { size: [g, h, d - 2 * g], at: [l / 2 - g / 2, h / 2, 0], thin: 'x' },
      { size: [l - 2 * g, g, d - 2 * g], at: [0, g / 2, 0], thin: 'y' },
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
    const { material: faceMaterial, skyNode } = createGlassFaceMaterial(
      medium,
      interior,
      this.waterBounds.getCenter(new Vector3()),
      this.algae,
      sky,
    );
    this.skyNodes.push(skyNode);
    this.blended.push([faceMaterial, vec4(0)]);
    const parts: [string, BufferGeometry[], Material][] = [
      ['glass-faces', faces, faceMaterial],
      ['glass-edges', edges, createGlassEdgeMaterial()],
    ];
    for (const [name, geometries, material] of parts) {
      const merged = mergeGeometries(geometries);
      for (const geometry of geometries) geometry.dispose();
      const mesh = this.track(new Mesh(merged, material));
      mesh.name = name;
      mesh.renderOrder = 2;
      this.group.add(mesh);
    }
  }

  /**
   * Most tanks have a dark backdrop on the back pane. It hides the room behind the tank, so what
   * is seen through the water is the water itself, darkening with depth. The camera can orbit
   * behind the tank, where the film's back shows, lit by the room.
   */
  private addBackdrop(medium: WaterMedium, interior: InteriorLight): void {
    const { length: l, depth: d, height: h } = this.dimensions;
    const material = new MeshBasicNodeMaterial({ side: DoubleSide });
    material.name = 'backdrop';
    material.fog = false;
    const back = interior.ambientAt(positionWorld, FORWARD.negate()).mul(color(BACKDROP_ALBEDO));
    material.colorNode = select(
      frontFacing,
      backdropRadiance(medium, interior, positionWorld),
      back,
    );
    const mesh = this.track(new Mesh(new PlaneGeometry(l, h), material));
    mesh.name = 'backdrop';
    mesh.position.set(0, h / 2, -d / 2 - BACKDROP_GAP);
    this.group.add(mesh);
  }

  /**
   * Two passes over the far faces of the water box handle whatever is seen through the
   * water without an object in it (the room behind): first multiply by the spectral
   * transmittance, then add the in-scattered light. Objects inside the water occlude
   * these faces and are fogged by the scene fog node instead.
   */
  private addWaterVolume(medium: WaterMedium): void {
    const size = this.waterBounds.getSize(this.waterBounds.max.clone());
    const centre = this.waterBounds.getCenter(this.waterBounds.min.clone());
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    this.disposables.push(geometry);

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
    this.blended.push([scatter, vec4(0)]);

    [absorb, scatter].forEach((material, i) => {
      const mesh = this.track(new Mesh(geometry, material));
      mesh.name = material.name;
      mesh.position.copy(centre);
      mesh.renderOrder = i - 2;
      this.group.add(mesh);
    });
  }

  private addWaterSurface(medium: WaterMedium, sky: Texture): void {
    const size = this.waterBounds.getSize(this.waterBounds.max.clone());
    const material = new MeshPhysicalNodeMaterial({ roughness: 0.02, metalness: 0, ior: 1.333 });
    material.name = 'water-surface';
    material.colorNode = vec3(0);
    const normal = rippleNormalWorld(this.rippleAmplitude.mul(0.01));
    material.normalNode = transformNormalByViewMatrix(normal, cameraViewMatrix);
    material.opacityNode = schlick(WATER_F0);
    premultipliedBlend(material);
    material.fog = false;
    material.outputNode = medium.applyPremultiplied(output);
    this.blended.push([material, vec4(0)]);

    const mesh = this.track(new Mesh(new PlaneGeometry(size.x, size.z), material));
    mesh.name = 'water-surface';
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, this.waterBounds.max.y, 0);
    mesh.renderOrder = 1;
    this.group.add(mesh);

    const below = createSurfaceUndersideMaterial(medium, normal, sky);
    const underside = this.track(new Mesh(mesh.geometry, below.material));
    underside.name = 'water-surface-underside';
    underside.rotation.copy(mesh.rotation);
    underside.position.copy(mesh.position);
    underside.renderOrder = 1;
    this.group.add(underside);
    this.skyNodes.push(below.skyNode);
  }

  private addStand(): void {
    const { length: l, depth: d } = this.dimensions;
    const height = 0.75;
    const material = new MeshStandardNodeMaterial({ color: new Color(0x1d1c1b), roughness: 0.55 });
    material.name = 'stand';
    const mesh = this.track(new Mesh(new BoxGeometry(l + 0.04, height, d + 0.04), material));
    mesh.name = 'stand';
    mesh.position.set(0, -height / 2, 0);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }
}
