import type { Node } from 'three/webgpu';
import {
  attribute,
  clamp,
  cos,
  float,
  floor,
  fract,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  sin,
  step,
  vec3,
} from 'three/tsl';
import { FIN_ATTRIBUTE, LEG_PART_ID, type Vec3 } from './assets';
import { APPENDAGE_RATE, WALK_GAIT } from './walk';

export interface Deformation {
  readonly position: Node<'vec3'>;
  readonly normal: Node<'vec3'>;
}

/** A walker's model-space rig, from the asset index and its LOD's geometry. */
export interface WalkerRig {
  /** Standard length in model units: the models are built in metres at the standard length. */
  readonly bodyLength: number;
  readonly hinge: { readonly y: number; readonly z: number };
  readonly telsonZ: number;
  /** Hip of each `_leg` index; null where the LOD dropped that leg. */
  readonly legPivots: readonly (Vec3 | null)[];
}

/** The instance values a walker's deformation reads; see `instances.ts` for the layout. */
export interface WalkerInputs {
  /** x the appendage clock (radians), z the per-animal seed 0..1. */
  readonly look: Node<'vec4'>;
  /** Leg phase 0..1, stride weight, tail curl (radians), pleopod paddling. */
  readonly walk: Node<'vec4'>;
  /** Picking, display. */
  readonly act: Node<'vec4'>;
}

const PART = { antenna: 7, pleopod: 8, abdomen: 9 } as const;

export function idIs(id: Node<'float'>, value: number): Node<'float'> {
  return step(value - 0.5, id).mul(step(id, value + 0.5));
}

function rotateX(v: Node<'vec3'>, c: Node<'float'>, s: Node<'float'>): Node<'vec3'> {
  return vec3(v.x, v.y.mul(c).sub(v.z.mul(s)), v.y.mul(s).add(v.z.mul(c)));
}

function rotateY(v: Node<'vec3'>, c: Node<'float'>, s: Node<'float'>): Node<'vec3'> {
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
}

function rotateZ(v: Node<'vec3'>, c: Node<'float'>, s: Node<'float'>): Node<'vec3'> {
  return vec3(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z);
}

/**
 * The walking deformation, in model space before instancing. Legs turn rigidly about their hips,
 * which keeps every tube's cross-section round however far it swings; the thin antennae and the
 * pleopod leaves bend by a shear that grows towards the tip; the abdomen and the pleopods on it curl
 * about the hinge by a share of the flexion set by their rest z, as the asset contract specifies.
 */
export function walkerDeformation(rig: WalkerRig, inputs: WalkerInputs): Deformation {
  const { look, walk, act } = inputs;
  const fin = attribute<'vec3'>(FIN_ATTRIBUTE, 'vec3');
  const weight = fin.x;
  const id = fin.y;
  const limb = fin.z;
  const p = positionGeometry;
  const n = normalGeometry;
  const clock = look.x;
  const seed = look.z;
  const g = WALK_GAIT;

  const pair = floor(limb.mul(0.5));
  const side = limb.sub(pair.mul(2));
  const sideSign = side.mul(2).sub(1);
  let pivot: Node<'vec3'> = vec3(0, 0, 0);
  rig.legPivots.forEach((hip, leg) => {
    if (hip !== null) pivot = pivot.add(vec3(...hip).mul(idIs(limb, leg)));
  });

  const isLeg = idIs(id, LEG_PART_ID);
  const walking = step(g.chelipedPairs - 0.5, pair).mul(isLeg);
  const u = fract(walk.x.sub(pair.mul(g.pairLag)).add(side.mul(0.5)));
  const planted = step(u, g.dutyFactor);
  const v = clamp(u.sub(g.dutyFactor).div(1 - g.dutyFactor), 0, 1);
  const swingSweep = v.mul(v).mul(v.mul(-2).add(3)).mul(2).sub(1);
  const sweep = mix(swingSweep, u.mul(-2 / g.dutyFactor).add(1), planted);
  const lift = sin(v.mul(Math.PI)).mul(planted.oneMinus());
  const stride = walk.y.mul(walking);
  // A foot forward of its hip on the +x side is a negative turn about +y, and a raised one a
  // positive turn about +z; the -x side mirrors both.
  const yaw = sweep.mul(stride).mul(sideSign).mul(-g.sweep);
  const roll = lift.mul(stride).mul(sideSign).mul(g.lift);
  const picking = isLeg.sub(walking);
  const pickArg = clock.mul(APPENDAGE_RATE.pick).add(side.mul(Math.PI)).add(pair.mul(1.3));
  const pitch = act.x.mul(picking).mul(sin(pickArg).mul(0.5).add(0.5)).mul(-g.pickPitch);

  const cy = cos(yaw);
  const sy = sin(yaw);
  const cr = cos(roll);
  const sr = sin(roll);
  const cp = cos(pitch);
  const sp = sin(pitch);
  const legRotate = (q: Node<'vec3'>): Node<'vec3'> =>
    rotateY(rotateZ(rotateX(q, cp, sp), cr, sr), cy, sy);
  const legPosition = pivot.add(legRotate(p.sub(pivot)));
  const legNormal = legRotate(n);

  const bodyLength = rig.bodyLength;
  const isAntenna = idIs(id, PART.antenna);
  const antennaArg = clock
    .mul(APPENDAGE_RATE.antenna)
    .add(seed.mul(Math.PI * 2))
    .add(limb.mul(1.7))
    .sub(weight.mul(2.5));
  const sway = mix(float(g.antennaSway), float(g.antennaDisplaySway), act.y)
    .mul(bodyLength)
    .mul(weight.mul(weight))
    .mul(isAntenna);
  const isPleopod = idIs(id, PART.pleopod);
  const beatArg = clock.mul(APPENDAGE_RATE.pleopod).add(pair.mul(g.pleopodLag));
  const beat = mix(float(g.pleopodFan), float(g.pleopodPaddle), walk.w)
    .mul(bodyLength)
    .mul(weight)
    .mul(isPleopod);
  const shear = vec3(
    sway.mul(sin(antennaArg)),
    sway
      .mul(0.6)
      .mul(cos(antennaArg.add(1.1)))
      .add(beat.mul(0.35).mul(cos(beatArg))),
    beat.mul(sin(beatArg)),
  );
  const bent = mix(p, legPosition, isLeg).add(shear);
  const bentNormal = mix(n, legNormal, isLeg);

  const { hinge, telsonZ } = rig;
  const isTail = isPleopod.add(idIs(id, PART.abdomen));
  const share = clamp(p.z.sub(hinge.z).div(telsonZ - hinge.z), 0, 1);
  // Positive flexion is ventral: the tail swings down, which is a negative turn about +x.
  const curl = walk.z.mul(share).mul(isTail).negate();
  const cc = cos(curl);
  const sc = sin(curl);
  const centre = vec3(0, hinge.y, hinge.z);
  const position = centre.add(rotateX(bent.sub(centre), cc, sc)).toVar('walkerPosition');
  const normal = normalize(rotateX(bentNormal, cc, sc)).toVar('walkerNormal');
  return { position, normal };
}
