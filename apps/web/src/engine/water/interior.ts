import { Color, type Node, type PMREMNode, type Texture, type UniformNode } from 'three/webgpu';
import { float, mix, pmremTexture, positionWorld, uniform, vec3 } from 'three/tsl';
import type { Caustics } from './caustics';
import type { WaterMedium } from './medium';

/**
 * Of the room around the tank, a point under water sees only what comes in through the front and
 * side panes, about a third of a cosine lobe. A real room is also some hundred times dimmer than
 * the water under a hood (200 against 20 000 lux), while the room map here is set near the hood's
 * level so that the glass and the frame read well; the rest of the factor puts that back.
 */
const ROOM_THROUGH_GLASS = 0.05;
/**
 * Hood light the substrate throws back, directly onto what faces down and, mirrored by the
 * underside of the surface past the critical angle, onto what faces up: about half of the
 * sand's radiance from every direction.
 */
const SUBSTRATE_BOUNCE = 0.5;

/**
 * The light from every direction but the hood's beam. Outside the water it is the room. Under
 * water the room only comes in through the glass, filtered by the water on its way, and the hood's
 * light bounced off the substrate takes its place, so what is in the tank takes the hood's colour.
 */
export class InteriorLight {
  /** The room's brightness relative to the day: its lamps at night. */
  readonly roomLevel = uniform(1);
  /** Linear albedo of the substrate, which colours the hood light it throws back. */
  readonly substrateAlbedo: UniformNode<'color', Color>;
  /**
   * The substrate's bounce depends on uniforms only, so it is found once per frame here: as a node
   * it would run in each of the environment lookups three builds per material.
   */
  readonly substrateBounce = uniform(new Color());
  /** Blue channel of the hood light at the substrate, which excites fluorescent tissue: the actinic by day and the moonlight at night. */
  actinicExcitation = 0;
  private readonly roomNodes: PMREMNode[] = [];

  /**
   * `substrateAlbedo` is read, not copied, so later changes to it are followed. `sandHeight` is
   * the mean height of the substrate's top, where the bounce leaves it.
   */
  constructor(
    private readonly medium: WaterMedium,
    private readonly caustics: Caustics,
    private room: Texture,
    substrateAlbedo: Color,
    private readonly sandHeight: number,
  ) {
    this.substrateAlbedo = uniform(substrateAlbedo);
  }

  /** Call once per frame, after the hood and water uniforms are set. */
  update(): void {
    const depth = this.medium.boxMax.value.y - this.sandHeight;
    this.caustics.hoodLightAtDepth(depth, this.substrateBounce.value);
    this.actinicExcitation = this.substrateBounce.value.b;
    this.substrateBounce.value
      .multiply(this.substrateAlbedo.value)
      .multiplyScalar(SUBSTRATE_BOUNCE / Math.PI);
  }

  setRoom(texture: Texture): void {
    this.room = texture;
    for (const node of this.roomNodes) node.value = texture;
  }

  /**
   * For `scene.environmentNode`: the PMREM lookup takes its direction and blur from the
   * environment lighting's context, so specular and diffuse both see the filtered room.
   */
  environmentNode(): Node<'vec3'> {
    return this.around(positionWorld, this.roomNode());
  }

  /** Mean radiance arriving at `p` from the hemisphere around `normal`, for surfaces shaded by hand. */
  ambientAt(p: Node<'vec3'>, normal: Node<'vec3'>): Node<'vec3'> {
    return this.around(p, this.roomNode(normal, float(1)));
  }

  private roomNode(direction?: Node<'vec3'>, roughness?: Node<'float'>): PMREMNode {
    const node = pmremTexture(this.room, direction, roughness);
    this.roomNodes.push(node);
    return node;
  }

  private around(p: Node<'vec3'>, room: Node<'vec3'>): Node<'vec3'> {
    const { medium } = this;
    const inWater = medium.submerged(p);
    const throughGlass = medium.transmittance(medium.boxMax.z.sub(p.z)).mul(ROOM_THROUGH_GLASS);
    const roomShare = mix(vec3(1), throughGlass, inWater);
    const bounce = this.substrateBounce.mul(inWater);
    return room.mul(this.roomLevel).mul(roomShare).add(bounce);
  }
}
