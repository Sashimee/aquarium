import type { Species } from '@aquarium/shared';
import { FishState } from '@aquarium/sim';

export type SwimmingMode = Species['locomotion']['swimmingMode'];
/** Walkers (`pleopod`, `none`) have no body wave; their legs, tail and antennae follow `walk.ts`. */
export type FinnedMode = Exclude<SwimmingMode, 'pleopod' | 'none'>;

export function isFinned(mode: SwimmingMode): mode is FinnedMode {
  return mode !== 'pleopod' && mode !== 'none';
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
/**
 * The mouth and the gill covers are the two pumps of one ventilation cycle (Hughes 1960, J Exp
 * Biol 37:28): the mouth opens to fill the buccal cavity while the covers are still shut, and
 * closes before they flare to let the water out. Its widest gape comes this share of a cycle ahead
 * of the covers' widest flare; a visual estimate.
 */
export const MOUTH_LEAD_CYCLES = 0.35;
/** A breath gapes this share of a feeding bite. */
export const BREATH_GAPE = 0.3;
/**
 * A suction-feeding bite opens to its full gape in tens of milliseconds and closes again within a
 * few hundred; stretched to the shortest that still reads at 60 Hz.
 */
export const BITE_OPEN_S = 0.05;
export const BITE_CLOSE_S = 0.2;
/**
 * Share of the hover undulation a client stills while posing at a cleaning station: posing fish
 * hang nearly motionless, fins spread, to invite inspection (Côté, Arnal & Reynolds 1998, J Fish
 * Biol 53:256). The amount and its settling time are visual estimates.
 */
export const POSE_STILLNESS = 0.75;
const POSE_SETTLE_S = 0.4;
/**
 * A cleaner in `Clean` slower than this is holding at a contact point rather than darting to one
 * (the sim holds at 0.1 x cruise, about 0.1 L/s for the cleaner wrasse, and darts at 0.25 x max).
 */
export const PECK_HOLD_BODY_LENGTHS_PER_S = 0.25;
/**
 * While holding, the cleaner snaps its jaws at the client's skin with a forward jerk of the head.
 * Pecks come this often, so a 0.3-1.2 s hold shows one to four; the rate, the first peck's delay
 * and the jab length are visual estimates.
 */
export const PECK_MIN_INTERVAL_S = 0.25;
export const PECK_MAX_INTERVAL_S = 0.5;
export const PECK_FIRST_S = 0.08;
export const PECK_JAB_BODY_LENGTHS = 0.06;
const GOLDEN_FRACTION = 0.618033988749895;
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
  /** The sim's `FishState`; -1 for a fish the sim does not move. */
  state: number;
}

/** A feeding bite's gape `t` seconds after it starts: 0 shut .. 1 wide open. */
export function biteGape(t: number): number {
  if (!(t >= 0) || t >= BITE_OPEN_S + BITE_CLOSE_S) return 0;
  if (t < BITE_OPEN_S) {
    const x = t / BITE_OPEN_S;
    return x * x * (3 - 2 * x);
  }
  const x = (t - BITE_OPEN_S) / BITE_CLOSE_S;
  return 1 - x * x * (3 - 2 * x);
}

/** The time into a bite's opening at which it has reached `gape`. */
function openingTime(gape: number): number {
  const g = clamp(gape, 0, 1);
  return BITE_OPEN_S * (0.5 - Math.sin(Math.asin(1 - 2 * g) / 3));
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
  /** Seconds since the last feeding bite started. */
  sinceBite = Infinity;
  /** 0 swimming .. 1 holding its cleaning pose, eased. */
  stillness = 0;
  /** Seconds since the last cleaning peck started. */
  sincePeck = Infinity;
  private peckDue = PECK_FIRST_S;
  private peckJitter: number;

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
    this.peckJitter = (((phaseOffset * GOLDEN_FRACTION) % 1) + 1) % 1;
  }

  /** Gill covers 0 closed .. 1 fully flared. */
  get gillOpening(): number {
    const stroke = RESTING_GILL_STROKE + (1 - RESTING_GILL_STROKE) * this.exertion;
    return stroke * 0.5 * (1 - Math.cos(this.ventilationPhase));
  }

  /** Mouth 0 shut .. 1 gaping at a bite; a breath opens it to `BREATH_GAPE` at most. */
  get mouthOpening(): number {
    const stroke = RESTING_GILL_STROKE + (1 - RESTING_GILL_STROKE) * this.exertion;
    const lead = MOUTH_LEAD_CYCLES * TAU;
    const breath = BREATH_GAPE * stroke * 0.5 * (1 - Math.cos(this.ventilationPhase + lead));
    return breath + (1 - breath) * biteGape(this.sinceBite);
  }

  /** How far, in body lengths, a cleaning peck has jerked the head forward: 0 at rest. */
  get jab(): number {
    return PECK_JAB_BODY_LENGTHS * biteGape(this.sincePeck);
  }

  /**
   * Starts a feeding gape, picking up from the gape of a bite still under way. `elapsed` is how
   * long ago, within the frame just advanced, the bite actually began.
   */
  bite(elapsed = 0): void {
    this.sinceBite = openingTime(biteGape(this.sinceBite - elapsed)) + elapsed;
  }

  advance(dt: number, sample: SwimSample): void {
    if (!(dt >= 0)) throw new RangeError(`swim: dt must be >= 0, got ${dt}`);
    const { length } = this;
    this.frequency = tailBeatHz(sample.speed, length, this.strouhal);
    const powered = sample.thrust > COAST_THRUST;
    const tau = powered ? DRIVE_RISE_S : 1 / (COAST_DECAY_PER_PERIOD * this.frequency);
    this.drive += ((powered ? 1 : 0) - this.drive) * (1 - Math.exp(-dt / tau));
    const posing = sample.state === FishState.Pose ? 1 : 0;
    this.stillness += (posing - this.stillness) * (1 - Math.exp(-dt / POSE_SETTLE_S));
    this.amplitude =
      amplitudeScale(sample.speed, length, this.drive) * (1 - POSE_STILLNESS * this.stillness);
    this.phase = (this.phase + TAU * this.frequency * dt) % TAU;
    const finHz = Math.max(this.frequency, this.mode.pectoralIdleHz);
    this.finPhase = (this.finPhase + TAU * finHz * dt) % TAU;
    this.exertion += (this.amplitude - this.exertion) * (1 - Math.exp(-dt / EXERTION_SETTLE_S));
    const ventilationHz =
      RESTING_VENTILATION_HZ + (EXERTED_VENTILATION_HZ - RESTING_VENTILATION_HZ) * this.exertion;
    this.ventilationPhase = (this.ventilationPhase + TAU * ventilationHz * dt) % TAU;
    this.sinceBite += dt;
    this.advancePecks(dt, sample);
    const target = turnCurvature(sample.yawRate, sample.speed, length);
    const k = 1 - Math.exp(-dt / BEND_SMOOTHING_S);
    this.curvature += (target - this.curvature) * k;
  }

  private advancePecks(dt: number, sample: SwimSample): void {
    this.sincePeck += dt;
    const holding =
      sample.state === FishState.Clean && sample.speed < PECK_HOLD_BODY_LENGTHS_PER_S * this.length;
    if (!holding) {
      this.peckDue = PECK_FIRST_S;
      return;
    }
    this.peckDue -= dt;
    if (this.peckDue > 0) return;
    this.sincePeck = -this.peckDue;
    this.bite(this.sincePeck);
    this.peckJitter = (this.peckJitter + GOLDEN_FRACTION) % 1;
    this.peckDue +=
      PECK_MIN_INTERVAL_S + (PECK_MAX_INTERVAL_S - PECK_MIN_INTERVAL_S) * this.peckJitter;
  }
}
