import type { Node } from 'three/webgpu';
import { max, sqrt, step } from 'three/tsl';

export const AIR_IOR = 1;
export const WATER_IOR = 1.333;

/**
 * Unpolarised Fresnel reflectance of a smooth dielectric boundary, for light arriving at `cosI`
 * from the side with index n1, where `eta` = n1 / n2. Past the critical angle (eta > 1 only) the
 * reflection is total.
 */
export function fresnelDielectric(cosI: Node<'float'>, eta: number): Node<'float'> {
  const sin2T = cosI
    .mul(cosI)
    .oneMinus()
    .mul(eta * eta)
    .toVar();
  const cosT = sqrt(max(sin2T.oneMinus(), 0)).toVar();
  const rs = cosI
    .mul(eta)
    .sub(cosT)
    .div(max(cosI.mul(eta).add(cosT), 1e-4));
  const rp = cosI.sub(cosT.mul(eta)).div(max(cosI.add(cosT.mul(eta)), 1e-4));
  const partial = rs.mul(rs).add(rp.mul(rp)).mul(0.5);
  return max(partial, step(1, sin2T));
}
