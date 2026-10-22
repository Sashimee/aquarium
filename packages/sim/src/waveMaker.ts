import { MAX_EQUIPMENT_TIER } from '@aquarium/shared';
import type { FishResize } from './fishArrays.ts';
import { clamp } from './math.ts';
import type { Sdf } from './sdf.ts';
import type { SimSpecies } from './species.ts';

/**
 * `steady`: one pump running constantly. `pulse`: one pump ramping between a floor and full power,
 * like a wave. `alternating`: a pair on opposite panes taking turns, so the gyre reverses.
 */
export type WaveMakerMode = 'steady' | 'pulse' | 'alternating';
const MODES: readonly WaveMakerMode[] = ['steady', 'pulse', 'alternating'];

export interface WaveMakerSettings {
  /** Horizontal push (x, z) of the pump across the top of the tank; any non-zero length. */
  readonly direction: readonly [number, number];
  /** Peak free-stream speed along the top of the gyre, m/s; 0 switches the pump off. */
  readonly speedMps: number;
  readonly mode: WaveMakerMode;
  /** The pulse period, or the whole cycle of an alternating pair (each pump runs half of it). */
  readonly periodS: number;
}

/** Every tunable of the wave maker current and the fish's response; sources in BEHAVIOUR.md. */
export const WAVE_MAKER = {
  maxSpeedMps: 0.3,
  tierSpeedMps: [0, 0.06, 0.12, 0.18],
  tierMode: ['steady', 'steady', 'pulse', 'alternating'],
  pulsePeriodS: 8,
  alternatingPeriodS: 40,
  pulseFloor: 0.25,
  alternatingSharpness: 3,
  boundaryLayerM: 0.04,
  holdfastGapM: 0.005,
  impermeableBoundaryLayers: 2,
  leeReachM: 0.08,
  leeShelter: 0.6,
  holdFractionLabriform: 0.7,
  holdFractionBodyCaudal: 0.5,
  sustainedFraction: 0.5,
  shelterReleaseRatio: 0.7,
  stressTauS: 5,
  refugeProbeBodyLengths: 1,
  refugeMinGradient: 0.05,
} as const;

/** Along the tank's length, the way a powerhead on the left pane pushes. */
export const DEFAULT_WAVE_MAKER_DIRECTION: readonly [number, number] = [1, 0];

/**
 * What a wave maker of this equipment tier does: tiers climb in flow and in pattern. Tier 0 is no
 * wave maker, and gives null.
 */
export function waveMakerForTier(
  tier: number,
  direction: readonly [number, number] = DEFAULT_WAVE_MAKER_DIRECTION,
): WaveMakerSettings | null {
  if (!Number.isInteger(tier) || tier < 0 || tier > MAX_EQUIPMENT_TIER) {
    throw new RangeError(
      `wave maker tier must be an integer from 0 to ${MAX_EQUIPMENT_TIER}, got ${tier}`,
    );
  }
  if (tier === 0) return null;
  const mode = WAVE_MAKER.tierMode[tier] ?? 'steady';
  return checkWaveMaker({
    direction,
    speedMps: WAVE_MAKER.tierSpeedMps[tier] ?? 0,
    mode,
    periodS: mode === 'alternating' ? WAVE_MAKER.alternatingPeriodS : WAVE_MAKER.pulsePeriodS,
  });
}

/** Validates settings from outside the sim and returns them with a unit direction. */
export function checkWaveMaker(settings: WaveMakerSettings): WaveMakerSettings {
  const { direction, speedMps, mode, periodS } = settings;
  const [dx, dz] = Array.isArray(direction) ? direction : [NaN, NaN];
  const length = isNumber(dx) && isNumber(dz) ? Math.hypot(dx, dz) : NaN;
  if (
    !Array.isArray(direction) ||
    direction.length !== 2 ||
    !Number.isFinite(length) ||
    length === 0
  ) {
    throw new RangeError(
      `wave maker direction must be a finite, non-zero [x, z], got ${JSON.stringify(direction)}`,
    );
  }
  if (!(isNumber(speedMps) && speedMps >= 0 && speedMps <= WAVE_MAKER.maxSpeedMps)) {
    throw new RangeError(
      `wave maker speedMps must be from 0 to ${WAVE_MAKER.maxSpeedMps}, got ${shown(speedMps)}`,
    );
  }
  if (!MODES.includes(mode)) {
    throw new RangeError(`wave maker mode must be one of ${MODES.join(', ')}, got "${mode}"`);
  }
  if (!(isNumber(periodS) && periodS > 0 && Number.isFinite(periodS))) {
    throw new RangeError(`wave maker periodS must be a positive number, got ${shown(periodS)}`);
  }
  return { direction: [(dx ?? 0) / length, (dz ?? 0) / length], speedMps, mode, periodS };
}

/** Settings cross the worker bridge untyped, and `>=` would let a string like "0" through. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** The water box the current circulates in, in the frame the samples are taken in. */
export interface FlowBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** The substrate. */
  readonly minY: number;
  /** The water surface. */
  readonly maxY: number;
}

/** The pump's push at one instant: a unit horizontal direction and a speed. */
export interface FlowSway {
  readonly direction: [number, number];
  readonly speed: number;
}

/**
 * The free-stream water velocity a wave maker drives: one gyre in the vertical plane along its
 * direction, out along the top from the pump's pane, down the far pane, back along the bottom and
 * up the pump's pane. It comes from a streamfunction, so it is divergence-free and, for a pump
 * square to the panes, has no flow into the glass. Purely a function of position and time, so the
 * sim, the scene and a replay that share the time sample the same water.
 */
export class FlowField {
  readonly settings: WaveMakerSettings;
  private readonly dx: number;
  private readonly dz: number;
  private readonly along0: number;
  private readonly alongSpan: number;
  private readonly minY: number;
  private readonly height: number;

  constructor(bounds: FlowBounds, settings: WaveMakerSettings) {
    const { minX, maxX, minZ, maxZ, minY, maxY } = bounds;
    if (![minX, maxX, minZ, maxZ, minY, maxY].every(Number.isFinite)) {
      throw new RangeError('flow bounds must be finite');
    }
    if (!(maxX > minX && maxZ > minZ && maxY > minY)) {
      throw new RangeError('flow bounds must have positive extent on every axis');
    }
    this.settings = checkWaveMaker(settings);
    const [dx, dz] = this.settings.direction;
    this.dx = dx;
    this.dz = dz;
    const corners = [minX * dx + minZ * dz, minX * dx + maxZ * dz, maxX * dx + minZ * dz];
    corners.push(maxX * dx + maxZ * dz);
    this.along0 = Math.min(...corners);
    this.alongSpan = Math.max(...corners) - this.along0;
    this.minY = minY;
    this.height = maxY - minY;
  }

  /** The pump's output at `timeS` as a signed fraction of `speedMps`; negative is reversed. */
  amplitude(timeS: number): number {
    const { mode, periodS } = this.settings;
    const phase = (2 * Math.PI * timeS) / periodS;
    switch (mode) {
      case 'steady':
        return 1;
      case 'pulse': {
        const floor = WAVE_MAKER.pulseFloor;
        return floor + (1 - floor) * 0.5 * (1 - Math.cos(phase));
      }
      case 'alternating':
        return clamp(WAVE_MAKER.alternatingSharpness * Math.sin(phase), -1, 1);
    }
  }

  /** Water velocity (m/s) at (x, y, z) and `timeS`, written to `out[0..2]`. */
  sample(x: number, y: number, z: number, timeS: number, out: Float64Array | number[]): void {
    const a = this.settings.speedMps * this.amplitude(timeS);
    const s = clamp((x * this.dx + z * this.dz - this.along0) / this.alongSpan, 0, 1);
    const h = clamp((y - this.minY) / this.height, 0, 1);
    const along = -a * Math.sin(Math.PI * s) * Math.cos(Math.PI * h);
    out[0] = along * this.dx;
    out[1] = ((a * this.height) / this.alongSpan) * Math.cos(Math.PI * s) * Math.sin(Math.PI * h);
    out[2] = along * this.dz;
  }

  /**
   * The push across the top of the gyre at `timeS`, for a sway uniform: a unit direction that
   * flips with an alternating pair, and a speed of 0 or more. Plants low in the tank sit in the
   * return flow; `sample` gives that per position.
   */
  sway(timeS: number): FlowSway {
    const a = this.amplitude(timeS);
    const sign = a < 0 ? -1 : 1;
    return {
      direction: [this.dx * sign, this.dz * sign],
      speed: this.settings.speedMps * Math.abs(a),
    };
  }
}

/** What `Currents` reads from the world each step. */
export interface CurrentsHost {
  readonly count: number;
  readonly position: Float64Array;
  readonly maxSpeed: Float64Array;
  readonly bodyLength: Float64Array;
  /** Half the body's depth: how far its centre sits off a surface it lies on. */
  readonly thickness: Float64Array;
  readonly speciesIndex: Int32Array;
  readonly species: readonly SimSpecies[];
  readonly time: number;
  /** Glass, substrate and hard decor: the surfaces the water slows against. */
  readonly substrateSdf: Sdf;
  readonly decorSdf: Sdf | null;
}

/**
 * The wave maker's effect on each fish: the water velocity where it is, after the shelter of
 * nearby surfaces and of rock upstream; how hard that is for it to hold against; and whether it
 * has had enough and makes for a refuge. Walkers cling to their surface and feel none of it, nor
 * does a fish lying on sand or rock or touching the glass, which holds station by pressing
 * against it (Arnold & Weihs 1978; Geerinckx et al. 2007).
 */
export class Currents {
  private field: FlowField | null = null;
  /** Local water velocity per fish, m/s, xyz. */
  flow: Float64Array;
  /** Local flow over the speed the fish can sustain, smoothed over `stressTauS`. */
  stress: Float64Array;
  /** 1 while the fish seeks a refuge from the flow. */
  shelter: Uint8Array;
  /** How far each fish's centre is from the nearest glass, sand, rock or water surface, m. */
  room: Float64Array;
  private surfaceY = 0;
  private readonly scratch = new Float64Array(3);
  private readonly normal = new Float64Array(3);

  constructor(count: number) {
    this.flow = new Float64Array(count * 3);
    this.stress = new Float64Array(count);
    this.shelter = new Uint8Array(count);
    this.room = new Float64Array(count);
  }

  get active(): boolean {
    return this.field !== null;
  }

  get flowField(): FlowField | null {
    return this.field;
  }

  /** A pump at speed 0 is no pump: the world then runs exactly as without one. */
  set(bounds: FlowBounds, settings: WaveMakerSettings | null): void {
    const checked = settings === null ? null : checkWaveMaker(settings);
    this.surfaceY = bounds.maxY;
    this.field = checked === null || checked.speedMps === 0 ? null : new FlowField(bounds, checked);
    if (this.field === null) {
      this.flow.fill(0);
      this.stress.fill(0);
      this.shelter.fill(0);
    }
  }

  resize(edit: FishResize): void {
    this.flow = edit.array(this.flow, 3);
    this.stress = edit.array(this.stress);
    this.shelter = edit.array(this.shelter);
    this.room = edit.array(this.room);
  }

  /** The most a fish puts against the flow: what reef fish hold in the field (Fulton 2007). */
  holdSpeed(host: CurrentsHost, i: number): number {
    const sp = host.species[host.speciesIndex[i] ?? 0];
    const fraction =
      sp?.swimmingMode === 'labriform'
        ? WAVE_MAKER.holdFractionLabriform
        : WAVE_MAKER.holdFractionBodyCaudal;
    return fraction * (host.maxSpeed[i] ?? 0);
  }

  update(host: CurrentsHost, dt: number): void {
    const field = this.field;
    if (field === null) return;
    const t = host.time;
    const ease = 1 - Math.exp(-dt / WAVE_MAKER.stressTauS);
    const out = this.scratch;
    for (let i = 0; i < host.count; i++) {
      const o = i * 3;
      if (host.species[host.speciesIndex[i] ?? 0]?.walking != null) {
        this.flow[o] = 0;
        this.flow[o + 1] = 0;
        this.flow[o + 2] = 0;
        continue;
      }
      const x = host.position[o] ?? 0;
      const y = host.position[o + 1] ?? 0;
      const z = host.position[o + 2] ?? 0;
      field.sample(x, y, z, t, out);
      const d = this.shelterFlow(host, x, y, z, out);
      this.room[i] = Math.min(d, this.surfaceY - y);
      if (d - (host.thickness[i] ?? 0) < WAVE_MAKER.holdfastGapM) out.fill(0);
      this.flow[o] = out[0] ?? 0;
      this.flow[o + 1] = out[1] ?? 0;
      this.flow[o + 2] = out[2] ?? 0;
      const hold = this.holdSpeed(host, i);
      const local = Math.hypot(this.flow[o] ?? 0, this.flow[o + 1] ?? 0, this.flow[o + 2] ?? 0);
      const ratio = hold > 0 ? local / hold : 0;
      const stress = (this.stress[i] ?? 0) + (ratio - (this.stress[i] ?? 0)) * ease;
      this.stress[i] = stress;
      const onset = WAVE_MAKER.sustainedFraction;
      const release = onset * WAVE_MAKER.shelterReleaseRatio;
      if (stress >= onset) this.shelter[i] = 1;
      else if (stress < release) this.shelter[i] = 0;
    }
  }

  /**
   * Turns the free stream `velocity` at (x, y, z) into what reaches that spot, in place: slowed in
   * the boundary layer against glass, sand and rock, and in the lee of rock upstream, where reef
   * fish find 60–100 % less flow (Johansen et al. 2008); and, since water does not flow through a
   * solid, with its push into the nearest surface fading out as the surface comes near. Returns
   * the distance to that surface.
   */
  private shelterFlow(
    host: CurrentsHost,
    x: number,
    y: number,
    z: number,
    velocity: Float64Array,
  ): number {
    const delta = WAVE_MAKER.boundaryLayerM;
    const n = this.normal;
    const d = host.substrateSdf.sample(x, y, z, n);
    let k = d > 0 ? 1 - Math.exp(-d / delta) : 0;
    let vx = velocity[0] ?? 0;
    let vy = velocity[1] ?? 0;
    let vz = velocity[2] ?? 0;
    const into = vx * (n[0] ?? 0) + vy * (n[1] ?? 0) + vz * (n[2] ?? 0);
    if (into < 0) {
      const cut = into * (1 - clamp(d / (WAVE_MAKER.impermeableBoundaryLayers * delta), 0, 1));
      vx -= (n[0] ?? 0) * cut;
      vy -= (n[1] ?? 0) * cut;
      vz -= (n[2] ?? 0) * cut;
    }
    const decor = host.decorSdf;
    const v = Math.hypot(vx, vy, vz);
    if (decor !== null && v > 1e-9 && k > 0) {
      const reach = WAVE_MAKER.leeReachM / v;
      const up = decor.sample(x - vx * reach, y - vy * reach, z - vz * reach, n);
      const open = up > 0 ? 1 - Math.exp(-up / delta) : 0;
      k *= 1 - WAVE_MAKER.leeShelter * (1 - open);
    }
    velocity[0] = vx * k;
    velocity[1] = vy * k;
    velocity[2] = vz * k;
    return d;
  }

  /**
   * The part of fish `i`'s local flow it swims against, into `out`: all of it up to its hold
   * speed, beyond which it is carried off.
   */
  counter(host: CurrentsHost, i: number, out: Float64Array): void {
    const o = i * 3;
    const fx = this.flow[o] ?? 0;
    const fy = this.flow[o + 1] ?? 0;
    const fz = this.flow[o + 2] ?? 0;
    const local = Math.hypot(fx, fy, fz);
    const hold = this.holdSpeed(host, i);
    const share = local > hold ? hold / local : 1;
    out[0] = fx * share;
    out[1] = fy * share;
    out[2] = fz * share;
  }

  /**
   * The unit direction from fish `i` toward slacker water, into `out`, by finite differences of
   * the sheltered flow speed one body length around it; false where the water is no slacker
   * anywhere near, so there is no direction worth taking.
   */
  refuge(host: CurrentsHost, i: number, out: Float64Array): boolean {
    const field = this.field;
    if (field === null) return false;
    const o = i * 3;
    const x = host.position[o] ?? 0;
    const y = host.position[o + 1] ?? 0;
    const z = host.position[o + 2] ?? 0;
    const h = WAVE_MAKER.refugeProbeBodyLengths * (host.bodyLength[i] ?? 0);
    if (!(h > 0)) return false;
    const t = host.time;
    const gx =
      this.speedAt(host, field, x + h, y, z, t) - this.speedAt(host, field, x - h, y, z, t);
    const gy =
      this.speedAt(host, field, x, y + h, z, t) - this.speedAt(host, field, x, y - h, z, t);
    const gz =
      this.speedAt(host, field, x, y, z + h, t) - this.speedAt(host, field, x, y, z - h, t);
    const g = Math.hypot(gx, gy, gz);
    const local = Math.hypot(this.flow[o] ?? 0, this.flow[o + 1] ?? 0, this.flow[o + 2] ?? 0);
    if (!(g > WAVE_MAKER.refugeMinGradient * local) || g < 1e-12) return false;
    out[0] = -gx / g;
    out[1] = -gy / g;
    out[2] = -gz / g;
    return true;
  }

  private speedAt(
    host: CurrentsHost,
    field: FlowField,
    x: number,
    y: number,
    z: number,
    t: number,
  ): number {
    const v = this.scratch;
    field.sample(x, y, z, t, v);
    this.shelterFlow(host, x, y, z, v);
    return Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  }
}
