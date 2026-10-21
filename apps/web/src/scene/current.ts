import { Vector3, type Node, type UniformNode } from 'three/webgpu';
import { float, max, min, sin, uniform, vec3 } from 'three/tsl';
import { DEFAULT_EQUIPMENT, equipmentProblems, type Biome } from '@aquarium/shared';
import { WAVE_MAKER, type FlowField } from '@aquarium/sim';

export interface CurrentParameters {
  /** Unit horizontal flow direction (x, z). */
  readonly direction: readonly [number, number];
  /** Mean filter flow in m/s. */
  readonly speed: number;
  readonly gustPeriodS: number;
  /** 0 is a steady flow, 1 swings the speed between 0 and twice the mean. */
  readonly gustDepth: number;
  /** Strongest pump the tank may run, m/s: reach and glass checks leave room for it. Default none. */
  readonly pumpMps?: number;
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

/** How far past its ambient lean, as a fraction of its height, the pump may push a tip. */
export const PUMP_LEAN_HEIGHT = 0.15;
/** The strongest pump the sim accepts; reach and glass checks assume it may be switched on. */
export const PUMP_PEAK_MPS = WAVE_MAKER.maxSpeedMps;

/** The current reach and glass checks use: biomes that may run a wave maker leave room for the strongest one. */
export function reachCurrent(current: CurrentParameters, biome: Biome): CurrentParameters {
  const pumpAllowed =
    equipmentProblems(biome, { ...DEFAULT_EQUIPMENT, waveMaker: { tier: 1 } }).length === 0;
  return { ...current, pumpMps: pumpAllowed ? PUMP_PEAK_MPS : 0 };
}

/**
 * Lean of `shear` metres, soft-capped: linear up to `linear` (the ambient current's peak, so
 * the pump-free scene is unchanged), then saturating at `linear + room` however hard it blows.
 */
export function limitLean(shear: number, linear: number, room: number): number {
  const over = Math.max(shear - linear, 0);
  return Math.min(shear, linear) + (over * room) / (room + over);
}

/** `limitLean` on a horizontal shear vector, keeping its direction. */
export function limitLeanNode(shear: Node<'vec3'>, linear: number, room: number): Node<'vec3'> {
  const length = max(shear.length(), 1e-6);
  const over = max(length.sub(linear), 0);
  const limited = min(length, linear).add(over.mul(room).div(over.add(room)));
  return shear.mul(limited.div(length));
}

/** A swaying thing's root, with the pump's flow there as a multiple of the pump's amplitude. */
export interface PumpRoot {
  readonly gain: UniformNode<'vec3', Vector3>;
  dispose(): void;
}

/** A time at which the pump is at its largest output, so dividing by it is safe. */
function fullStrengthTime(field: FlowField): number {
  const { periodS, speedMps } = field.settings;
  if (speedMps === 0) return 0;
  let best = 0;
  let bestAmplitude = 0;
  for (const quarter of [0, 0.25, 0.5, 0.75]) {
    const amplitude = Math.abs(field.amplitude(quarter * periodS));
    if (amplitude > bestAmplitude) {
      bestAmplitude = amplitude;
      best = quarter * periodS;
    }
  }
  if (!(speedMps * bestAmplitude > 0))
    throw new RangeError('the wave maker has no output to sway with');
  return best;
}

export class CurrentField {
  readonly direction = uniform(new Vector3(1, 0, 0));
  readonly speed = uniform(0.04);
  readonly gustPeriodS = uniform(9);
  readonly gustDepth = uniform(0.4);
  readonly elapsed = uniform(0);
  readonly flutterElapsed = uniform(0);
  /** The pump's signed output in m/s, `speedMps * amplitude(t)`; times a root's gain it is the flow there. */
  readonly pumpAmplitude = uniform(0);

  private params: CurrentParameters = {
    direction: [1, 0],
    speed: 0.04,
    gustPeriodS: 9,
    gustDepth: 0.4,
  };
  private timeS = 0;
  private waveField: FlowField | null = null;
  private waveTimeS = 0;
  private gainTimeS = 0;
  private readonly scratch = new Float64Array(3);
  private readonly pumpListeners = new Set<() => void>();

  get parameters(): CurrentParameters {
    return this.params;
  }

  get time(): number {
    return this.timeS;
  }

  get waveMaker(): FlowField | null {
    return this.waveField;
  }

  /**
   * The pump's flow field. `World` lives in the sim worker, so
   * the caller builds the `FlowField` (null without a pump) with `new FlowField(bounds, settings)`
   * from `@aquarium/sim`. `bounds` must match the sim's `World.flowBounds()`, which is private to
   * the worker; take the same minX/maxX/minZ/maxZ/minY/maxY from `Basin.fromTank(tank)` or
   * `Basin.fromSpace(space)` built from the config the worker was given.
   * `simTimeS` is the sim snapshot's `time`. A pump with `speedMps` 0 is off: it sways nothing and gains 0.
   */
  setWaveMaker(field: FlowField | null, simTimeS: number): void {
    this.waveField = field;
    this.gainTimeS = field === null ? 0 : fullStrengthTime(field);
    this.syncWaveMaker(simTimeS);
    for (const listener of this.pumpListeners) listener();
  }

  /** Call every frame with the sim snapshot's `time`; the render clock never drives the pump. */
  syncWaveMaker(simTimeS: number): void {
    this.waveTimeS = simTimeS;
    const field = this.waveField;
    this.pumpAmplitude.value =
      field === null ? 0 : field.settings.speedMps * field.amplitude(simTimeS);
  }

  /**
   * The pump's flow at a root as a multiple of `pumpAmplitude`, horizontal (x, z) into `out`.
   * Read from `FlowField.sample` at the instant the pump is at full strength, so it is the sim's
   * field, not a copy of it.
   */
  pumpGainAt(x: number, y: number, z: number, out: Float64Array | Float32Array | number[]): void {
    const field = this.waveField;
    if (field === null) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const full = field.settings.speedMps * field.amplitude(this.gainTimeS);
    if (full === 0) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    field.sample(x, y, z, this.gainTimeS, this.scratch);
    out[0] = (this.scratch[0] ?? 0) / full;
    out[1] = (this.scratch[2] ?? 0) / full;
  }

  /** Reruns `listener` whenever the pump is installed, changed or removed; returns its unsubscribe. */
  onWaveMakerChange(listener: () => void): () => void {
    this.pumpListeners.add(listener);
    return () => this.pumpListeners.delete(listener);
  }

  /** A uniform holding the pump's gain at a root, kept current as the pump changes. */
  pumpRoot(x: number, y: number, z: number): PumpRoot {
    const gain = uniform(new Vector3());
    const at = new Float64Array(2);
    const refresh = () => {
      this.pumpGainAt(x, y, z, at);
      gain.value.set(at[0] ?? 0, 0, at[1] ?? 0);
    };
    refresh();
    const release = this.onWaveMakerChange(refresh);
    return { gain, dispose: release };
  }

  /** The pump's horizontal flow in the tank frame at a root with this gain. */
  pumpVelocity(gain: Node<'vec3'>): Node<'vec3'> {
    return gain.mul(this.pumpAmplitude);
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
    const field = this.waveField;
    if (field === null) return;
    field.sample(x, y, z, this.waveTimeS, this.scratch);
    out[0] = (out[0] ?? 0) + (this.scratch[0] ?? 0);
    out[2] = (out[2] ?? 0) + (this.scratch[2] ?? 0);
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
