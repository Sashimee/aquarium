import type { Material, Node } from 'three/webgpu';
import { materialColor, materialReference, vec3, vec4 } from 'three/tsl';

/**
 * Linear albedo of a bare aragonite skeleton. Lerping the tint toward 1 only uncovers the scan's
 * own dull or saturated tone, so the bleached colour replaces the scan colour instead.
 */
export const BLEACHED_SKELETON_ALBEDO = 0.85;

const BLEACH_PROPERTY = 'bleach';

/** Live albedo blended toward the bare skeleton; exactly `live` at bleach 0. */
export function bleachedAlbedo(live: Node<'vec3'>, bleach: Node<'float'>): Node<'vec3'> {
  return live.add(vec3(BLEACHED_SKELETON_ALBEDO).sub(live).mul(bleach));
}

// @types/three 0.186 types these loosely: materialColor is color × map, a vec4 carrying the map's
// alpha whenever there is a map, and materialReference drops the node type it is given.
const live = vec4(materialColor as unknown as Node<'vec4'>);
const bleachAmount = materialReference(
  `userData.${BLEACH_PROPERTY}`,
  'float',
) as unknown as Node<'float'>;

/**
 * One graph for every coral: the amount is read per material from `userData.bleach`, so corals at
 * different bleach levels still share a program.
 */
export const coralBleachColor: Node<'vec4'> = vec4(bleachedAlbedo(live.rgb, bleachAmount), live.a);

export function setMaterialBleach(material: Material, bleach: number): void {
  material.userData[BLEACH_PROPERTY] = Math.min(1, Math.max(0, bleach));
}
