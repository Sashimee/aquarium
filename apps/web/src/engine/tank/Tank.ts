import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  CustomBlending,
  Group,
  Mesh,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  SrcColorFactor,
  ZeroFactor,
  type Box3,
  type Material,
  type Node,
} from 'three/webgpu';
import {
  abs,
  cameraViewMatrix,
  cos,
  dot,
  float,
  normalView,
  normalize,
  output,
  positionViewDirection,
  positionWorld,
  pow,
  time,
  transformNormalByViewMatrix,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WaterMedium } from '../water/medium';
import { type TankDimensions, validateTank, waterBounds } from './dimensions';
import { createSubstrateGeometry, createSubstrateMaterial } from './substrate';

const GLASS_F0 = 0.04;
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

/**
 * The faces of a pane only reflect: diffuse is black and the output is premultiplied,
 * so the reflection adds on top while the scene behind is kept by (1 - F).
 */
function createGlassFaceMaterial(medium: WaterMedium): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.03, metalness: 0 });
  material.name = 'glass-face';
  material.colorNode = vec3(0);
  material.opacityNode = schlick(GLASS_F0);
  premultipliedBlend(material);
  material.fog = false;
  material.outputNode = medium.applyPremultiplied(output);
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
function rippleNormalView(amplitude: Node<'float'>): Node<'vec3'> {
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
  const worldNormal = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()));
  return transformNormalByViewMatrix(worldNormal, cameraViewMatrix);
}

export class Tank {
  readonly group = new Group();
  readonly waterBounds: Box3;
  readonly substrate: Mesh;
  readonly rippleAmplitude = uniform(0.12);
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    readonly dimensions: TankDimensions,
    medium: WaterMedium,
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

    this.addGlass(medium);
    this.addWaterVolume(medium);
    this.addWaterSurface(medium);
    this.addStand();
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
  private addGlass(medium: WaterMedium): void {
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
    const parts: [string, BufferGeometry[], Material][] = [
      ['glass-faces', faces, createGlassFaceMaterial(medium)],
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

    const absorb = new NodeMaterial();
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
    absorb.fragmentNode = vec4(medium.volumeTransmittance(), 1);

    const scatter = new NodeMaterial();
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
    scatter.fragmentNode = vec4(medium.volumeInScatter(), 0);

    [absorb, scatter].forEach((material, i) => {
      const mesh = this.track(new Mesh(geometry, material));
      mesh.name = material.name;
      mesh.position.copy(centre);
      mesh.renderOrder = i - 2;
      this.group.add(mesh);
    });
  }

  private addWaterSurface(medium: WaterMedium): void {
    const size = this.waterBounds.getSize(this.waterBounds.max.clone());
    const material = new MeshPhysicalNodeMaterial({ roughness: 0.02, metalness: 0, ior: 1.333 });
    material.name = 'water-surface';
    material.colorNode = vec3(0);
    material.normalNode = rippleNormalView(this.rippleAmplitude.mul(0.01));
    material.opacityNode = schlick(WATER_F0);
    premultipliedBlend(material);
    material.fog = false;
    material.outputNode = medium.applyPremultiplied(output);

    const mesh = this.track(new Mesh(new PlaneGeometry(size.x, size.z), material));
    mesh.name = 'water-surface';
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, this.waterBounds.max.y, 0);
    mesh.renderOrder = 1;
    this.group.add(mesh);
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
