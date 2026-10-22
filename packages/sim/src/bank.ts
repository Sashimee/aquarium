import type { Anchor, BehaviourHost, Plan } from './behaviour.ts';
import { BEHAVIOUR } from './behaviour.ts';
import type { FishResize } from './fishArrays.ts';
import { wrapAngle } from './math.ts';
import { FishState } from './snapshot.ts';
import type { SimSpecies } from './species.ts';

/** Every tunable of an amphibious fish hauling out onto an emergent bank; sources are in BEHAVIOUR.md. */
export const BANK = {
  /** Mean time in the water between haul-outs, drawn as a Poisson hazard. */
  submergedMeanS: 45,
  emersedMinS: 40,
  emersedMaxS: 160,
  /** A fish that has not reached its staging point in this long forgets the bank. */
  approachGiveUpS: 30,
  approachSpeedFraction: 0.5,
  /** How often a fish at its staging point checks again that it has room to climb. */
  retryS: 0.5,
  /** Rings round the bank, outside its radius, a staging point is looked for on. */
  stageRingsBodyLengths: [0.5, 0.8, 1.1, 1.5, 2],
  stageBearings: 16,
  stageDepthBodyLengths: 0.5,
  arriveBodyLengths: 0.5,
  /** How far behind the snout the pectoral fins grip the perch. */
  gripBodyLengths: 0.25,
  /** Body pitch climbing up the side of the bank, capped by the species' own pitch limit. */
  climbPitchRad: (50 * Math.PI) / 180,
  /** Body pitch lying on the perch, head up. */
  perchPitchRad: (10 * Math.PI) / 180,
  /** The highest a perch may stand above the water. */
  reachBodyLengths: 3,
  marginBodyLengths: 0.02,
  /** How far a perch pose is raised looking for room above a cramped tip. */
  raiseBodyLengths: 0.5,
  climbBodyLengthsPerS: 1,
  skipBodyLengthsPerS: 4,
  turnRadPerS: Math.PI,
  /** Path checks sample poses at most this many body thicknesses apart. */
  pathStepThickness: 0.5,
} as const;

const Phase = { None: 0, Approach: 1, Climb: 2, Perch: 3, Return: 4 } as const;

/** Keyframes per path, each x, y, z, yaw, pitch. */
const KEYS = 4;
const KEY = 5;
/** Per fish posed by this module this step: x, y, z, yaw, pitch, speed. */
const POSE = 6;

const DT = 1 / 30;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

function writeKey(
  out: Float64Array,
  o: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
): void {
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = yaw;
  out[o + 4] = pitch;
}

/**
 * Amphibious fish (mudskippers) leave the water for an emergent bank: one swims to a staging point
 * just under the surface beside a free bank, climbs out along a straight path checked against the
 * glass and rock, rests on the perch, then turns and goes back down, or backs down when there is no
 * room to turn. Out of the water the fish is posed along that path, not steered, so it never meets
 * the water surface the steering keeps every swimmer under. A startle sends it back at skipping
 * speed. With no bank the module draws nothing from the RNG and the fish stays in the water.
 */
export class Banks {
  private banks: readonly Anchor[] = [];
  private _posed: Uint8Array;
  private _pose: Float64Array;
  private phase: Uint8Array;
  private bank: Int32Array;
  private timer: Float64Array;
  private retry: Float64Array;
  private path: Float64Array;
  private keys: Uint8Array;
  private duration: Float64Array;
  private clock: Float64Array;
  private rate: Float64Array;
  private stage: Float64Array;
  private lift: Float64Array;
  private perch: Float64Array;

  private readonly host: BehaviourHost;
  private readonly key = new Float64Array(KEY);
  private readonly n3 = new Float64Array(3);

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._posed = new Uint8Array(n);
    this._pose = new Float64Array(n * POSE);
    this.phase = new Uint8Array(n);
    this.bank = new Int32Array(n).fill(-1);
    this.timer = new Float64Array(n);
    this.retry = new Float64Array(n);
    this.path = new Float64Array(n * KEYS * KEY);
    this.keys = new Uint8Array(n);
    this.duration = new Float64Array(n * KEYS);
    this.clock = new Float64Array(n);
    this.rate = new Float64Array(n);
    this.stage = new Float64Array(n * KEY);
    this.lift = new Float64Array(n * KEY);
    this.perch = new Float64Array(n * KEY);
  }

  /** 1 for a fish this module placed this step; `World` copies its `pose` instead of steering it. */
  get posed(): Uint8Array {
    return this._posed;
  }

  /** Per fish: x, y, z, yaw, pitch and speed, read where `posed` is 1. */
  get pose(): Float64Array {
    return this._pose;
  }

  get count(): number {
    return this.banks.length;
  }

  resize(edit: FishResize): void {
    this._posed = edit.array(this._posed);
    this._pose = edit.array(this._pose, POSE);
    this.phase = edit.array(this.phase);
    this.bank = edit.array(this.bank, 1, -1);
    this.timer = edit.array(this.timer);
    this.retry = edit.array(this.retry);
    this.path = edit.array(this.path, KEYS * KEY);
    this.keys = edit.array(this.keys);
    this.duration = edit.array(this.duration, KEYS);
    this.clock = edit.array(this.clock);
    this.rate = edit.array(this.rate);
    this.stage = edit.array(this.stage, KEY);
    this.lift = edit.array(this.lift, KEY);
    this.perch = edit.array(this.perch, KEY);
  }

  /** Out of the water, or on the way out or back. */
  emersed(i: number): boolean {
    const p = at(this.phase, i);
    return p === Phase.Climb || p === Phase.Perch || p === Phase.Return;
  }

  /** The bank fish `i` is on or making for, or -1. */
  bankOf(i: number): number {
    return at(this.phase, i) === Phase.None ? -1 : at(this.bank, i);
  }

  /**
   * Takes the validated bank list. A fish keeps a bank that is still there unchanged; one whose
   * bank moved or went is put back in the water if it was out.
   */
  setBanks(banks: readonly Anchor[]): void {
    const old = this.banks;
    this.banks = banks;
    for (let i = 0; i < this.host.count; i++) {
      if (at(this.phase, i) === Phase.None) continue;
      const was = old[at(this.bank, i)];
      const k =
        was === undefined
          ? -1
          : banks.findIndex(
              (b) =>
                b.id === was.id &&
                b.radius === was.radius &&
                b.position.every((v, c) => v === was.position[c]),
            );
      if (k >= 0) this.bank[i] = k;
      else this.leave(i);
    }
  }

  /** Hard decor moved: a fish whose path or perch it now blocks is put back in the water. */
  decorMoved(): void {
    for (let i = 0; i < this.host.count; i++) {
      const p = at(this.phase, i);
      if (p === Phase.Approach) this.phase[i] = Phase.None;
      else if (p !== Phase.None && !this.restClear(i)) this.leave(i);
    }
  }

  /** Clears last step's poses; call before planning. */
  update(): void {
    this._posed.fill(0);
  }

  /**
   * Plans a fish that is out of the water, or on its way out or back, and poses it. `startled`
   * sends it back at skipping speed. False for a fish in the water.
   */
  planEmersed(i: number, plan: Plan, startled: boolean): boolean {
    if (!this.emersed(i)) return false;
    if (startled) this.flee(i);
    plan.state = FishState.Emerse;
    plan.wander = 0;
    plan.align = 0;
    plan.cohesion = 0;
    if (at(this.phase, i) === Phase.Perch) {
      const left = at(this.timer, i) - DT;
      this.timer[i] = left;
      if (left > 0) {
        this.place(i, this.perch, i * KEY, 0);
        return true;
      }
      this.beginReturn(i, 1);
    }
    this.play(i);
    return true;
  }

  /**
   * Swims an amphibious fish in the water to its staging point, or decides whether it heads for a
   * bank now. Draws from the RNG only when the tank has a bank. False when it stays in the water.
   */
  planApproach(i: number, sp: SimSpecies, plan: Plan, rest: number): boolean {
    if (at(this.phase, i) !== Phase.Approach) {
      if (!sp.amphibious || this.banks.length === 0 || rest > 0.5) return false;
      const p = 1 - Math.exp(-DT / BANK.submergedMeanS);
      if (this.host.rng.next() >= p || !this.choose(i, sp)) return false;
      this.phase[i] = Phase.Approach;
      this.timer[i] = BANK.approachGiveUpS;
      this.retry[i] = 0;
    }
    const left = at(this.timer, i) - DT;
    this.timer[i] = left;
    if (left <= 0) {
      this.phase[i] = Phase.None;
      return false;
    }
    const { position, basin } = this.host;
    const length = at(this.host.bodyLength, i);
    const o = i * KEY;
    const sx = at(this.stage, o);
    const sy = at(this.stage, o + 1);
    const sz = at(this.stage, o + 2);
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    if (Math.hypot(sx - px, sy - py, sz - pz) <= BANK.arriveBodyLengths * length) {
      const wait = at(this.retry, i) - DT;
      this.retry[i] = wait;
      if (wait <= 0) {
        this.retry[i] = BANK.retryS;
        if (this.beginClimb(i)) return this.planEmersed(i, plan, false);
      }
    }
    plan.state = FishState.Forage;
    plan.floor = false;
    plan.surface = false;
    plan.continuous = true;
    plan.wander = 0;
    plan.align = 0;
    plan.cohesion = 0;
    plan.bandLo = basin.ground(px, pz);
    plan.bandHi = basin.maxY;
    plan.seek(sx, sy, sz, BANK.approachSpeedFraction * at(this.host.maxSpeed, i), 0.3);
    return true;
  }

  /**
   * The nearest bank, in plan view, no other fish is using and that has a staging point with a
   * clear climb to a perch within reach. Draws nothing.
   */
  private choose(i: number, sp: SimSpecies): boolean {
    const { position } = this.host;
    const px = at(position, i * 3);
    const pz = at(position, i * 3 + 2);
    const order = this.banks
      .map((b, k) => ({ k, d: Math.hypot(b.position[0] - px, b.position[2] - pz) }))
      .filter(({ k }) => !this.taken(i, k))
      .sort((a, b) => a.d - b.d || a.k - b.k);
    for (const { k } of order) {
      if (this.stageFor(i, sp, k)) {
        this.bank[i] = k;
        return true;
      }
    }
    return false;
  }

  private taken(i: number, k: number): boolean {
    for (let j = 0; j < this.host.count; j++) {
      if (j !== i && at(this.phase, j) !== Phase.None && at(this.bank, j) === k) return true;
    }
    return false;
  }

  /**
   * Finds, on the innermost ring that has one, the staging point nearest fish `i` from which it can
   * climb bank `k`: straight up beside it at the climbing pitch until level with the perch, then
   * over onto the top, levelling out. Stores the staging, lift and perch poses.
   */
  private stageFor(i: number, sp: SimSpecies, k: number): boolean {
    const b = this.banks[k];
    if (b === undefined) return false;
    const { basin, position } = this.host;
    const length = at(this.host.bodyLength, i);
    if (b.position[1] - basin.maxY > BANK.reachBodyLengths * length) return false;
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    const sy = basin.maxY - BANK.stageDepthBodyLengths * length;
    const climb = Math.min(BANK.climbPitchRad, sp.maxPitch);
    const perch = Math.min(BANK.perchPitchRad, sp.maxPitch);
    const o = i * KEYS * KEY;
    const path = this.path;
    const so = i * KEY;
    for (const ring of BANK.stageRingsBodyLengths) {
      const r = b.radius + ring * length;
      let best = Infinity;
      for (let m = 0; m < BANK.stageBearings; m++) {
        const theta = (2 * Math.PI * m) / BANK.stageBearings;
        const sx = b.position[0] + r * Math.sin(theta);
        const sz = b.position[2] + r * Math.cos(theta);
        const d = Math.hypot(sx - px, sy - py, sz - pz);
        if (d >= best) continue;
        const yaw = Math.atan2(b.position[0] - sx, b.position[2] - sz);
        if (!this.perchOn(i, b, yaw, perch, o + 3 * KEY)) continue;
        writeKey(path, o + KEY, sx, sy, sz, yaw, climb);
        writeKey(path, o + 2 * KEY, sx, at(path, o + 3 * KEY + 1), sz, yaw, climb);
        if (!this.poseClear(i, sx, sy, sz, yaw, climb)) continue;
        if (!this.legClear(i, 1) || !this.legClear(i, 2)) continue;
        best = d;
        this.stage.set(path.subarray(o + KEY, o + 2 * KEY), so);
        this.lift.set(path.subarray(o + 2 * KEY, o + 3 * KEY), so);
        this.perch.set(path.subarray(o + 3 * KEY, o + 4 * KEY), so);
      }
      if (best < Infinity) return true;
    }
    return false;
  }

  /**
   * The perch pose on bank `b` for a fish facing `yaw`: pectoral fins on the cling point, body
   * lying over the top behind them, raised until it clears the bank. Written to `path` at `o`.
   */
  private perchOn(i: number, b: Anchor, yaw: number, pitch: number, o: number): boolean {
    const length = at(this.host.bodyLength, i);
    const thickness = length * BEHAVIOUR.bodyThicknessBodyLengths;
    const cp = Math.cos(pitch);
    const grip = BANK.gripBodyLengths * length;
    const x = b.position[0] - Math.sin(yaw) * cp * grip;
    const z = b.position[2] - Math.cos(yaw) * cp * grip;
    const base =
      b.position[1] - Math.sin(pitch) * grip + thickness + BANK.marginBodyLengths * length;
    const step = BANK.pathStepThickness * thickness;
    const reach = this.host.basin.maxY + BANK.reachBodyLengths * length;
    for (let raise = 0; raise <= BANK.raiseBodyLengths * length; raise += step) {
      const y = base + raise;
      if (y > reach) return false;
      if (!this.poseClear(i, x, y, z, yaw, pitch)) continue;
      writeKey(this.path, o, x, y, z, yaw, pitch);
      return true;
    }
    return false;
  }

  /**
   * Starts the climb from where the fish is: turn and move onto the staging pose, up beside the
   * bank, then onto the perch. The first leg is checked here; the rest was when the staging point
   * was chosen.
   */
  private beginClimb(i: number): boolean {
    const { position, forward } = this.host;
    const o = i * KEYS * KEY;
    const path = this.path;
    writeKey(
      path,
      o,
      at(position, i * 3),
      at(position, i * 3 + 1),
      at(position, i * 3 + 2),
      at(this.host.yaw, i),
      Math.asin(Math.max(-1, Math.min(1, at(forward, i * 3 + 1)))),
    );
    path.set(this.stage.subarray(i * KEY, i * KEY + KEY), o + KEY);
    path.set(this.lift.subarray(i * KEY, i * KEY + KEY), o + 2 * KEY);
    path.set(this.perch.subarray(i * KEY, i * KEY + KEY), o + 3 * KEY);
    this.keys[i] = 4;
    // The heading the fish has is not the one the staging pose has; turn the short way.
    path[o + 3] = at(path, o + KEY + 3) + wrapAngle(at(path, o + 3) - at(path, o + KEY + 3));
    if (!this.legClear(i, 0)) return false;
    this.phase[i] = Phase.Climb;
    this.rate[i] = 1;
    this.timeLegs(i);
    return true;
  }

  /**
   * Turns round on the perch and goes back down the way it came, head first, or backs down when
   * there is no room to turn. Head first, the body passes through the poses it climbed through.
   */
  private beginReturn(i: number, rate: number): void {
    const o = i * KEYS * KEY;
    const k = i * KEY;
    const path = this.path;
    this.phase[i] = Phase.Return;
    this.rate[i] = rate;
    path.set(this.perch.subarray(k, k + KEY), o);
    const yaw = at(this.perch, k + 3);
    for (const turn of [Math.PI, -Math.PI]) {
      const back = (src: Float64Array, to: number): void => {
        path.set(src.subarray(k, k + KEY), to);
        path[to + 3] = yaw + turn;
        path[to + 4] = -at(src, k + 4);
      };
      back(this.perch, o + KEY);
      back(this.lift, o + 2 * KEY);
      back(this.stage, o + 3 * KEY);
      this.keys[i] = 4;
      if (this.legClear(i, 0)) {
        this.timeLegs(i);
        return;
      }
    }
    path.set(this.lift.subarray(k, k + KEY), o + KEY);
    path.set(this.stage.subarray(k, k + KEY), o + 2 * KEY);
    this.keys[i] = 3;
    this.timeLegs(i);
  }

  /**
   * Back the way it came at skipping speed: retraces the climb from where it is, or on the perch
   * or the way down hurries the way down.
   */
  private flee(i: number): void {
    const rate = BANK.skipBodyLengthsPerS / BANK.climbBodyLengthsPerS;
    const p = at(this.phase, i);
    if (p === Phase.Perch) {
      this.beginReturn(i, rate);
      return;
    }
    this.rate[i] = rate;
    if (p !== Phase.Climb) return;
    const o = i * KEYS * KEY;
    const leg = this.legAt(i);
    const key = this.key;
    this.interpolate(i, leg, key);
    const back: number[] = [...key];
    for (let s = leg; s >= 0; s--) {
      for (let c = 0; c < KEY; c++) back.push(at(this.path, o + s * KEY + c));
    }
    this.path.set(back, o);
    this.keys[i] = leg + 2;
    this.phase[i] = Phase.Return;
    this.timeLegs(i);
  }

  /** Puts a fish that was out of the water, or on its way, back in the water by its staging point. */
  private leave(i: number): void {
    const wasOut = this.emersed(i);
    this.phase[i] = Phase.None;
    if (!wasOut) return;
    const o = i * KEY;
    const spot = this.host.waterSpotNear(
      i,
      at(this.stage, o),
      at(this.stage, o + 1),
      at(this.stage, o + 2),
    );
    // Decor filling the whole tank leaves nowhere to go; the body constraint takes over.
    if (spot === null) return;
    this.key.set(spot);
    this.key[3] = at(this.host.yaw, i);
    this.key[4] = 0;
    this.place(i, this.key, 0, 0);
  }

  private timeLegs(i: number): void {
    const o = i * KEYS * KEY;
    const length = at(this.host.bodyLength, i);
    const speed = BANK.climbBodyLengthsPerS * length;
    for (let s = 0; s + 1 < at(this.keys, i); s++) {
      const a = o + s * KEY;
      const b = a + KEY;
      const dist = Math.hypot(
        at(this.path, b) - at(this.path, a),
        at(this.path, b + 1) - at(this.path, a + 1),
        at(this.path, b + 2) - at(this.path, a + 2),
      );
      const yaw = Math.abs(at(this.path, b + 3) - at(this.path, a + 3));
      const pitch = Math.abs(at(this.path, b + 4) - at(this.path, a + 4));
      this.duration[i * KEYS + s] = Math.max(
        dist / speed,
        Math.max(yaw, pitch) / BANK.turnRadPerS,
        DT,
      );
    }
    this.clock[i] = 0;
  }

  /** The leg the fish's clock is on. */
  private legAt(i: number): number {
    let t = at(this.clock, i);
    const legs = at(this.keys, i) - 1;
    for (let s = 0; s < legs; s++) {
      const d = at(this.duration, i * KEYS + s);
      if (t < d || s === legs - 1) return s;
      t -= d;
    }
    return 0;
  }

  /** The pose at the fish's clock, which lies on `leg`. */
  private interpolate(i: number, leg: number, out: Float64Array): void {
    let t = at(this.clock, i);
    for (let s = 0; s < leg; s++) t -= at(this.duration, i * KEYS + s);
    const u = Math.max(0, Math.min(1, t / at(this.duration, i * KEYS + leg)));
    const a = i * KEYS * KEY + leg * KEY;
    for (let c = 0; c < KEY; c++) {
      out[c] = at(this.path, a + c) + (at(this.path, a + KEY + c) - at(this.path, a + c)) * u;
    }
  }

  /** Advances the fish along its path and poses it; at the end it perches or swims off. */
  private play(i: number): void {
    const legs = at(this.keys, i) - 1;
    let total = 0;
    for (let s = 0; s < legs; s++) total += at(this.duration, i * KEYS + s);
    const before = at(this.clock, i);
    const clock = Math.min(total, before + DT * at(this.rate, i));
    this.clock[i] = clock;
    const leg = this.legAt(i);
    const key = this.key;
    this.interpolate(i, leg, key);
    const legTime = at(this.duration, i * KEYS + leg);
    const a = i * KEYS * KEY + leg * KEY;
    const legLength = Math.hypot(
      at(this.path, a + KEY) - at(this.path, a),
      at(this.path, a + KEY + 1) - at(this.path, a + 1),
      at(this.path, a + KEY + 2) - at(this.path, a + 2),
    );
    const speed = (legLength / legTime) * at(this.rate, i);
    if (clock < total) {
      this.place(i, key, 0, speed);
      return;
    }
    if (at(this.phase, i) === Phase.Climb) {
      this.phase[i] = Phase.Perch;
      this.timer[i] = this.host.rng.range(BANK.emersedMinS, BANK.emersedMaxS);
      this.rate[i] = 1;
      this.place(i, this.perch, i * KEY, 0);
      return;
    }
    this.phase[i] = Phase.None;
    this.rate[i] = 1;
    this.place(i, key, 0, speed);
  }

  private place(i: number, src: Float64Array, o: number, speed: number): void {
    const p = i * POSE;
    for (let c = 0; c < KEY; c++) this._pose[p + c] = at(src, o + c);
    this._pose[p + 3] = wrapAngle(at(src, o + 3));
    this._pose[p + 5] = speed;
    this._posed[i] = 1;
  }

  /** Whether what is left of the fish's path, or its perch, is still clear. */
  private restClear(i: number): boolean {
    if (at(this.phase, i) === Phase.Perch) {
      const o = i * KEY;
      const q = this.perch;
      return this.poseClear(i, at(q, o), at(q, o + 1), at(q, o + 2), at(q, o + 3), at(q, o + 4));
    }
    for (let s = this.legAt(i); s + 1 < at(this.keys, i); s++) {
      if (!this.legClear(i, s)) return false;
    }
    return true;
  }

  private legClear(i: number, leg: number): boolean {
    const a = i * KEYS * KEY + leg * KEY;
    const path = this.path;
    const length = at(this.host.bodyLength, i);
    const step = BANK.pathStepThickness * BEHAVIOUR.bodyThicknessBodyLengths * length;
    const dist = Math.hypot(
      at(path, a + KEY) - at(path, a),
      at(path, a + KEY + 1) - at(path, a + 1),
      at(path, a + KEY + 2) - at(path, a + 2),
    );
    const sweep =
      Math.max(
        Math.abs(at(path, a + KEY + 3) - at(path, a + 3)),
        Math.abs(at(path, a + KEY + 4) - at(path, a + 4)),
      ) *
      0.5 *
      length;
    const n = Math.max(1, Math.ceil(Math.max(dist, sweep) / step));
    for (let m = 0; m <= n; m++) {
      const u = m / n;
      const pose = (c: number): number =>
        at(path, a + c) + (at(path, a + KEY + c) - at(path, a + c)) * u;
      if (!this.poseClear(i, pose(0), pose(1), pose(2), pose(3), pose(4))) return false;
    }
    return true;
  }

  /** Whether a body of fish `i`'s size at this pose clears the glass, the sand and hard decor. */
  private poseClear(
    i: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
  ): boolean {
    const length = at(this.host.bodyLength, i);
    const thickness = length * BEHAVIOUR.bodyThicknessBodyLengths;
    const cp = Math.cos(pitch);
    const fx = Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = Math.cos(yaw) * cp;
    const sdf = this.host.substrateSdf;
    for (const s of BEHAVIOUR.bodySampleOffsets) {
      const k = s * length;
      if (sdf.sample(x + fx * k, y + fy * k, z + fz * k, this.n3) < thickness) return false;
    }
    return true;
  }
}
