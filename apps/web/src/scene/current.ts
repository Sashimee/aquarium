import { Vector3, type Node } from 'three/webgpu';
import { float, sin, uniform, vec3 } from 'three/tsl';

export interface CurrentParameters {
  /** Unit horizontal flow direction (x, z). */
  readonly direction: readonly [number, number];
  /** Mean filter flow in m/s. */
  readonly speed: number;
  readonly gustPeriodS: number;
  /** 0 is a steady flow, 1 swings the speed between 0 and twice the mean. */
  readonly gustDepth: number;
}

const TWO_PI = Math.PI * 2;
const GUST_WAVENUMBER = 9;
const MEANDER_RATIO = 0.6;
export const MEANDER_AMPLITUDE = 0.35;
const MEANDER_WAVENUMBER = 7;
const MEANDER_HEIGHT_PHASE = 3;
const VERTICAL_RATIO = 0.08;
const VERTICAL_WAVENUMBER = 11;

export const FLUTTER_HZ = 0.9;
const FLUTTER_PERIOD_S = 1 / FLUTTER_HZ;

/** Three gust periods hold a whole number of meander periods (3 / 0.6 = 5). */
export function wrapPeriodS(p: CurrentParameters): number {
  return 3 * p.gustPeriodS;
}

export function normaliseDirection(direction: readonly [number, number]): [number, number] {
  const length = Math.hypot(direction[0], direction[1]);
  if (!(length > 0)) throw new RangeError('current direction must not be zero');
  return [direction[0] / length, direction[1] / length];
}

/**
 * Water velocity (m/s, tank space) at a point and time: a filter flow carrying slow travelling
 * gusts, with a sideways meander. `CurrentField.velocityNode` is the same formula in TSL, so
 * plants, food particles and the sim all see one field.
 */
export function sampleCurrent(
  p: CurrentParameters,
  x: number,
  y: number,
  z: number,
  timeS: number,
  out: Float64Array | number[],
): void {
  const [dx, dz] = p.direction;
  const along = x * dx + z * dz;
  const across = z * dx - x * dz;
  const w = TWO_PI / p.gustPeriodS;
  const swell = 1 + p.gustDepth * Math.sin(w * timeS - GUST_WAVENUMBER * along);
  const meander =
    MEANDER_AMPLITUDE *
    p.gustDepth *
    Math.sin((w / MEANDER_RATIO) * timeS + MEANDER_WAVENUMBER * across + MEANDER_HEIGHT_PHASE * y);
  const forward = p.speed * swell;
  const sideways = p.speed * meander;
  out[0] = forward * dx - sideways * dz;
  out[1] = p.speed * VERTICAL_RATIO * Math.sin(w * timeS - VERTICAL_WAVENUMBER * along);
  out[2] = forward * dz + sideways * dx;
}

export class CurrentField {
  readonly direction = uniform(new Vector3(1, 0, 0));
  readonly speed = uniform(0.04);
  readonly gustPeriodS = uniform(9);
  readonly gustDepth = uniform(0.4);
  readonly elapsed = uniform(0);
  readonly flutterElapsed = uniform(0);

  private params: CurrentParameters = {
    direction: [1, 0],
    speed: 0.04,
    gustPeriodS: 9,
    gustDepth: 0.4,
  };
  private timeS = 0;

  get parameters(): CurrentParameters {
    return this.params;
  }

  get time(): number {
    return this.timeS;
  }

  configure(parameters: CurrentParameters): void {
    const direction = normaliseDirection(parameters.direction);
    this.params = { ...parameters, direction };
    this.direction.value.set(direction[0], 0, direction[1]);
    this.speed.value = parameters.speed;
    this.gustPeriodS.value = parameters.gustPeriodS;
    this.gustDepth.value = parameters.gustDepth;
    this.advance(0);
  }

  /**
   * Time is wrapped so float32 shader arithmetic stays precise after long uptime. The gust and
   * meander both repeat every `wrapPeriodS`, so the wrap is invisible.
   */
  advance(deltaS: number): void {
    this.timeS = (this.timeS + deltaS) % wrapPeriodS(this.params);
    this.elapsed.value = this.timeS;
    this.flutterElapsed.value = this.timeS % FLUTTER_PERIOD_S;
  }

  sample(x: number, y: number, z: number, out: Float64Array | number[]): void {
    sampleCurrent(this.params, x, y, z, this.timeS, out);
  }

  velocityNode(position: Node<'vec3'>): Node<'vec3'> {
    const dir = this.direction;
    const along = position.x.mul(dir.x).add(position.z.mul(dir.z));
    const across = position.z.mul(dir.x).sub(position.x.mul(dir.z));
    const w = float(TWO_PI).div(this.gustPeriodS);
    const t = this.elapsed;
    const swell = this.gustDepth.mul(sin(w.mul(t).sub(along.mul(GUST_WAVENUMBER)))).add(1);
    const meander = this.gustDepth
      .mul(MEANDER_AMPLITUDE)
      .mul(
        sin(
          w
            .div(MEANDER_RATIO)
            .mul(t)
            .add(across.mul(MEANDER_WAVENUMBER))
            .add(position.y.mul(MEANDER_HEIGHT_PHASE)),
        ),
      );
    const forward = this.speed.mul(swell);
    const sideways = this.speed.mul(meander);
    const vertical = this.speed
      .mul(VERTICAL_RATIO)
      .mul(sin(w.mul(t).sub(along.mul(VERTICAL_WAVENUMBER))));
    return vec3(
      forward.mul(dir.x).sub(sideways.mul(dir.z)),
      vertical,
      forward.mul(dir.z).add(sideways.mul(dir.x)),
    );
  }
}
