import type { Species } from '@aquarium/shared';

export type SwimmingMode = Species['locomotion']['swimmingMode'];
/** Walkers (`pleopod`) have no body wave; their legs, tail and antennae follow `walk.ts`. */
export type FinnedMode = Exclude<SwimmingMode, 'pleopod'>;

export function isFinned(mode: SwimmingMode): mode is FinnedMode {
  return mode !== 'pleopod';
}

export interface SwimModeParams {
  /**
   * Lateral amplitude envelope a(s) = c0 + c1·s + c2·s², normalised so a(1) = 1, where s runs
   * from 0 at the snout to 1 at the tail tip.
   */
  readonly envelope: readonly [number, number, number];
  /** Body wavelength in body lengths. */
  readonly wavelength: number;
  /** Scale on the body wave; labriform swimmers keep the body almost rigid. */
  readonly bodyWave: number;
  /** Pectoral stroke amplitude, in body lengths. */
  readonly pectoral: number;
  /** Dorsal and anal fin undulation amplitude, in body lengths. */
  readonly medianFin: number;
  /** Pectoral beat while hovering, when the Strouhal frequency is lower. */
  readonly pectoralIdleHz: number;
}

/**
 * Carangiform: Videler & Hess 1984 (J Exp Biol 109:209) measured A(x)/L = 0.02 − 0.08x + 0.16x²
 * for saithe and mackerel, i.e. a stiff head with some recoil and the amplitude in the rear third;
 * wavelength ≈ 1 L (Videler 1993, Fish Swimming). Subcarangiform (trout, Webb et al. 1984) bends
 * from about a third of the body with λ ≈ 0.8 L; anguilliform moves the whole body with
 * λ ≈ 0.6 L (Gillis 1996). Labriform swimmers row with the pectorals and keep the body stiff.
 * Fin amplitudes are visual estimates.
 */
export const SWIM_MODES: Readonly<Record<FinnedMode, SwimModeParams>> = {
  carangiform: {
    envelope: [0.2, -0.8, 1.6],
    wavelength: 1,
    bodyWave: 1,
    pectoral: 0.04,
    medianFin: 0.015,
    pectoralIdleHz: 1.5,
  },
  subcarangiform: {
    envelope: [0.15, -0.45, 1.3],
    wavelength: 0.8,
    bodyWave: 1,
    pectoral: 0.05,
    medianFin: 0.02,
    pectoralIdleHz: 1.5,
  },
  anguilliform: {
    envelope: [0.3, 0.1, 0.6],
    wavelength: 0.6,
    bodyWave: 1,
    pectoral: 0.03,
    medianFin: 0.03,
    pectoralIdleHz: 1.2,
  },
  labriform: {
    envelope: [0.2, -0.8, 1.6],
    wavelength: 1,
    bodyWave: 0.3,
    pectoral: 0.09,
    medianFin: 0.035,
    pectoralIdleHz: 2.5,
  },
};

/** Peak-to-peak tail amplitude ≈ 0.2 L across speeds (Bainbridge 1958, J Exp Biol 35:109). */
export const TAIL_AMPLITUDE_BODY_LENGTHS = 0.2;
/** A resting fish still undulates gently to hold station. */
export const IDLE_TAIL_BEAT_HZ = 1;
/** Above this the beat aliases against a 60 Hz display; real bursts reach it only briefly. */
export const MAX_TAIL_BEAT_HZ = 20;
/** Body-wave amplitude while hovering, as a fraction of the cruising amplitude. */
export const IDLE_AMPLITUDE = 0.2;
/** Speed (body lengths per second) from which the full tail amplitude is used. */
export const FULL_AMPLITUDE_BODY_LENGTHS_PER_S = 1.5;
/** Turning on the spot: the bend saturates as if the fish moved at this speed (BL/s). */
export const MIN_TURN_SPEED_BODY_LENGTHS_PER_S = 0.5;
/** Strongest body bend, as curvature × body length, short of a C-start. */
export const MAX_BEND = 3;
const BEND_SMOOTHING_S = 0.08;
/**
 * Thrust (fraction of the maximum) below which the sim's fish is gliding. Coasting tetras hold the
 * body "passive and straight" (Li et al. 2021, Commun Biol 4:68), so the beat dies out within one
 * tail period: e^-3, 5% left, after one period. A kick restarts it about as fast as the sim's 0.1 s
 * burst response.
 */
export const COAST_THRUST = 1e-3;
const COAST_DECAY_PER_PERIOD = 3;
/**
 * Opercular pumping of a small teleost at rest and at full exertion, in beats per second; visual
 * estimates within the 1-3 Hz that small tropical fish ventilate at. Exertion raises both the rate
 * and the stroke, and both settle back over a few seconds rather than with the tail beat.
 */
export const RESTING_VENTILATION_HZ = 1.4;
export const EXERTED_VENTILATION_HZ = 3;
const RESTING_GILL_STROKE = 0.6;
const EXERTION_SETTLE_S = 2.5;
const DRIVE_RISE_S = 0.03;
const TAU = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function requirePositiveLength(length: number): void {
  if (!(length > 0)) throw new RangeError(`swim: body length must be > 0, got ${length}`);
}

/** Strouhal coupling f = St·U/A with A the peak-to-peak tail amplitude (Taylor et al. 2003). */
export function tailBeatHz(speed: number, length: number, strouhal: number): number {
  requirePositiveLength(length);
  const f = (strouhal * Math.max(speed, 0)) / (TAIL_AMPLITUDE_BODY_LENGTHS * length);
  return clamp(f, IDLE_TAIL_BEAT_HZ, MAX_TAIL_BEAT_HZ);
}

/**
 * Fraction of the cruising body-wave amplitude used at this speed: 0.2 hovering, 1 cruising.
 * `drive` (0 gliding .. 1 powered) scales the swimming share only, so a resting fish keeps its
 * station-holding undulation while a coasting one goes straight.
 */
export function amplitudeScale(speed: number, length: number, drive: number): number {
  requirePositiveLength(length);
  const x = clamp(Math.max(speed, 0) / length / FULL_AMPLITUDE_BODY_LENGTHS_PER_S, 0, 1);
  const eased = x * x * (3 - 2 * x);
  return IDLE_AMPLITUDE * (1 - eased) + eased * clamp(drive, 0, 1);
}

/**
 * Path curvature κ = ω/U (1/m) that the body bends into, positive for a left turn. Turning on the
 * spot would divide by ~0, so the speed is floored and the bend clamped.
 */
export function turnCurvature(yawRate: number, speed: number, length: number): number {
  requirePositiveLength(length);
  const u = Math.max(speed, MIN_TURN_SPEED_BODY_LENGTHS_PER_S * length);
  return clamp(yawRate / u, -MAX_BEND / length, MAX_BEND / length);
}

export function envelopeAt(mode: SwimModeParams, s: number): number {
  const [c0, c1, c2] = mode.envelope;
  return c0 + c1 * s + c2 * s * s;
}

export interface SwimSample {
  speed: number;
  yawRate: number;
  /** Caudal thrust as a fraction of the maximum, 0 while coasting; 1 for scripted poses. */
  thrust: number;
}

/**
 * Per-fish swim phase. Frequency changes with speed, so the phase is integrated rather than
 * computed as f·t: f·t would jump whenever f changes.
 */
export class SwimState {
  phase: number;
  finPhase: number;
  amplitude = IDLE_AMPLITUDE;
  /** Smoothed 0 gliding .. 1 powered, so a coast fades the beat instead of cutting it. */
  drive = 1;
  curvature = 0;
  frequency = IDLE_TAIL_BEAT_HZ;
  /** 0 hovering .. 1 cruising, the body-wave amplitude slowly averaged. */
  exertion = IDLE_AMPLITUDE;
  ventilationPhase: number;

  constructor(
    readonly length: number,
    readonly strouhal: number,
    readonly mode: SwimModeParams,
    phaseOffset: number,
  ) {
    requirePositiveLength(length);
    this.phase = phaseOffset % TAU;
    this.finPhase = (phaseOffset * 1.618) % TAU;
    this.ventilationPhase = (phaseOffset * 2.414) % TAU;
  }

  /** Gill covers 0 closed .. 1 fully flared. */
  get gillOpening(): number {
    const stroke = RESTING_GILL_STROKE + (1 - RESTING_GILL_STROKE) * this.exertion;
    return stroke * 0.5 * (1 - Math.cos(this.ventilationPhase));
  }

  advance(dt: number, sample: SwimSample): void {
    if (!(dt >= 0)) throw new RangeError(`swim: dt must be >= 0, got ${dt}`);
    const { length } = this;
    this.frequency = tailBeatHz(sample.speed, length, this.strouhal);
    const powered = sample.thrust > COAST_THRUST;
    const tau = powered ? DRIVE_RISE_S : 1 / (COAST_DECAY_PER_PERIOD * this.frequency);
    this.drive += ((powered ? 1 : 0) - this.drive) * (1 - Math.exp(-dt / tau));
    this.amplitude = amplitudeScale(sample.speed, length, this.drive);
    this.phase = (this.phase + TAU * this.frequency * dt) % TAU;
    const finHz = Math.max(this.frequency, this.mode.pectoralIdleHz);
    this.finPhase = (this.finPhase + TAU * finHz * dt) % TAU;
    this.exertion += (this.amplitude - this.exertion) * (1 - Math.exp(-dt / EXERTION_SETTLE_S));
    const ventilationHz =
      RESTING_VENTILATION_HZ + (EXERTED_VENTILATION_HZ - RESTING_VENTILATION_HZ) * this.exertion;
    this.ventilationPhase = (this.ventilationPhase + TAU * ventilationHz * dt) % TAU;
    const target = turnCurvature(sample.yawRate, sample.speed, length);
    const k = 1 - Math.exp(-dt / BEND_SMOOTHING_S);
    this.curvature += (target - this.curvature) * k;
  }
}
