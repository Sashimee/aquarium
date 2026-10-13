import type { BehaviourHost } from './behaviour.ts';
import type { FishResize } from './fishArrays.ts';
import { MAX_FEEDERS, MAX_FOOD_PARTICLES, type AteEvent } from './food.ts';
import { clamp } from './math.ts';
import { selectNearest } from './neighbours.ts';

/** Every tunable of the feeding AI; sources are in BEHAVIOUR.md. */
export const FEEDING = {
  satiationPortions: 1,
  gastricEvacuationTauS: 4 * 3600,
  satiatedMotivation: 0.05,
  minScore: 0.04,
  retargetS: 0.25,
  switchRatio: 1.3,
  keepRangeFactor: 1.5,
  zoneReach: 0.35,
  bottomZoneReach: 0.15,
  zoneEdgeSalience: 0.25,
  motionSalienceGain: 1,
  motionReferenceMps: 0.02,
  mouthBodyLengths: 0.4,
  biteReachBodyLengths: 0.4,
  handlingS: 0.4,
  grazeBiteS: 1.5,
  grazeBitePortion: 0.01,
  pursuitTimeoutS: 6,
  ignoreS: 10,
  reachChecks: 3,
  pursuitSpeedFraction: 0.6,
  leashBodyLengths: 5,
  followNeighbours: 6,
  schoolFactor: 0.2,
  approachComfort: 0.3,
  reachHeightBodyLengths: 0.3,
  brakeBodyLengths: 3,
  strikeSpeedFactor: 0.5,
  grazeSpeedFactor: 0.25,
  resolveRounds: 3,
  buriedM: 0.005,
} as const;

const DT = 1 / 30;
const EMPTY = 1e-9;

/**
 * Where a fish holds its body centre to take food at height `y`, over sand at height `floor` and
 * under the surface at `top`. Food on the sand or at the meniscus is taken with the centre a
 * little way off that surface, the mouth tipped to it.
 */
export function feedingHeight(y: number, length: number, floor: number, top: number): number {
  const off = FEEDING.reachHeightBodyLengths * length;
  return clamp(y, floor + off, top - off);
}

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * Per-fish feeding state: satiation, the particle each fish is after, and the claims that decide
 * which of several fish closing on one particle gets it. `Behaviour` fills `eligible` and `leash`
 * before every `update` and turns the targets into plans afterwards.
 */
export class Feeding {
  private _gut: Float64Array;
  private _target: Int32Array;
  private _follow: Int32Array;
  private _handling: Float64Array;
  private _eligible: Uint8Array;
  private _leash: Float64Array;
  readonly events: AteEvent[] = [];

  private readonly host: BehaviourHost;
  private targetId: Int32Array;
  private targetScore: Float64Array;
  private pursuit: Float64Array;
  private ignoreId: Int32Array;
  private ignoreTimer: Float64Array;
  private retarget: Float64Array;
  private looked: Uint8Array;
  private lost: Int32Array;
  private lostNext: Int32Array;
  private readonly claimFish = new Int32Array(MAX_FOOD_PARTICLES * MAX_FEEDERS);
  private readonly claimDist = new Float64Array(MAX_FOOD_PARTICLES * MAX_FEEDERS);
  private readonly claimCount = new Uint8Array(MAX_FOOD_PARTICLES);
  private readonly candidates = new Int32Array(MAX_FOOD_PARTICLES);
  private readonly unreachable = new Int32Array(FEEDING.reachChecks);
  private unreachableCount = 0;
  /** Score of the particle the last `choose` returned. */
  private chosenScore = 0;
  private readonly buried = new Uint8Array(MAX_FOOD_PARTICLES);
  private readonly n3 = new Float64Array(3);
  private readonly nbr = new Int32Array(FEEDING.followNeighbours);
  private readonly nbrDist = new Float64Array(FEEDING.followNeighbours);

  /** Feed portions in the stomach; empties exponentially (gastric evacuation). */
  get gut(): Float64Array {
    return this._gut;
  }

  /** Index into the food store of the particle being pursued, or -1. */
  get target(): Int32Array {
    return this._target;
  }

  /** Fish index of a feeding neighbour this fish is swimming towards, or -1. */
  get follow(): Int32Array {
    return this._follow;
  }

  /** Time left handling the last item swallowed, or until the next rasp of a grazed item. */
  get handling(): Float64Array {
    return this._handling;
  }

  /** 1 when the fish may feed this step. */
  get eligible(): Uint8Array {
    return this._eligible;
  }

  /** Per fish x, y, z, radius of the area it will leave home for; radius Infinity for none. */
  get leash(): Float64Array {
    return this._leash;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._gut = new Float64Array(n);
    this._target = new Int32Array(n).fill(-1);
    this._follow = new Int32Array(n).fill(-1);
    this._handling = new Float64Array(n);
    this._eligible = new Uint8Array(n);
    this._leash = new Float64Array(n * 4);
    this.targetId = new Int32Array(n).fill(-1);
    this.targetScore = new Float64Array(n);
    this.pursuit = new Float64Array(n);
    this.ignoreId = new Int32Array(n).fill(-1);
    this.ignoreTimer = new Float64Array(n);
    // Staggered by index rather than drawn from the RNG, so a tank without food keeps the exact
    // trajectory it had before feeding existed.
    this.retarget = Float64Array.from({ length: n }, (_, i) => (i % 8) * DT);
    this.looked = new Uint8Array(n);
    this.lost = new Int32Array(n);
    this.lostNext = new Int32Array(n);
  }

  /** 1 for an empty stomach, 0 for a full one. */
  motivation(i: number): number {
    return clamp(1 - at(this.gut, i) / FEEDING.satiationPortions, 0, 1);
  }

  /**
   * Follows a fish joining or leaving. A fish following the one that left, or holding a claim
   * beside it, forgets it; bites it already took stay in `events`.
   */
  resize(edit: FishResize): void {
    this._gut = edit.array(this.gut);
    this._target = edit.array(this.target, 1, -1);
    this._follow = edit.array(this.follow, 1, -1);
    this._handling = edit.array(this.handling);
    this._eligible = edit.array(this.eligible);
    this._leash = edit.array(this.leash, 4);
    this.targetId = edit.array(this.targetId, 1, -1);
    this.targetScore = edit.array(this.targetScore);
    this.pursuit = edit.array(this.pursuit);
    this.ignoreId = edit.array(this.ignoreId, 1, -1);
    this.ignoreTimer = edit.array(this.ignoreTimer);
    this.retarget = edit.array(this.retarget, 1, (edit.count % 8) * DT);
    this.looked = edit.array(this.looked);
    this.lost = edit.array(this.lost);
    this.lostNext = edit.array(this.lostNext);
    edit.remap(this.follow);
    edit.remap(this.lost);
    edit.remap(this.lostNext);
    if (edit.removed < 0) return;
    for (let k = 0; k < MAX_FOOD_PARTICLES; k++) {
      const o = k * MAX_FEEDERS;
      const count = at(this.claimCount, k);
      let kept = 0;
      for (let m = 0; m < count; m++) {
        const j = edit.index(at(this.claimFish, o + m));
        if (j < 0) continue;
        this.claimFish[o + kept] = j;
        this.claimDist[o + kept] = at(this.claimDist, o + m);
        kept++;
      }
      this.claimCount[k] = kept;
    }
  }

  /** Fish holding a claim on particle `k`, nearest first, as of the last update. */
  claimants(k: number): number[] {
    const o = k * MAX_FEEDERS;
    return Array.from(this.claimFish.subarray(o, o + at(this.claimCount, k)));
  }

  update(): void {
    const n = this.host.count;
    const { food } = this.host;
    const empty = Math.exp(-DT / FEEDING.gastricEvacuationTauS);
    for (let i = 0; i < n; i++) {
      this.gut[i] = at(this.gut, i) * empty;
      this.handling[i] = Math.max(0, at(this.handling, i) - DT);
      this.ignoreTimer[i] = at(this.ignoreTimer, i) - DT;
      if (at(this.ignoreTimer, i) <= 0) this.ignoreId[i] = -1;
      this.retarget[i] = at(this.retarget, i) - DT;
      this.looked[i] = 0;
    }
    if (food.count === 0) {
      for (let i = 0; i < n; i++) this.drop(i);
      return;
    }
    // Food reported inside rock or glass (a client physics slip) can never be reached; chasing it
    // would only press fish against the surface.
    const field = this.host.substrateSdf;
    for (let k = 0; k < food.count; k++) {
      const d = field.sample(
        at(food.position, k * 3),
        at(food.position, k * 3 + 1),
        at(food.position, k * 3 + 2),
        this.n3,
      );
      this.buried[k] = d < -FEEDING.buriedM ? 1 : 0;
    }

    for (let i = 0; i < n; i++) {
      if (!this.hungry(i)) {
        this.drop(i);
        continue;
      }
      const id = at(this.targetId, i);
      if (id < 0) continue;
      const k = food.indexOf(id);
      if (k < 0 || food.remaining(k) <= EMPTY || this.buried[k] === 1 || !this.keeps(i, k)) {
        this.drop(i);
        this.retarget[i] = 0;
        continue;
      }
      this.target[i] = k;
      this.pursuit[i] = at(this.pursuit, i) + DT;
      if (at(this.pursuit, i) > FEEDING.pursuitTimeoutS) {
        // Out of reach (wedged in a crevice, behind rock): give up on it for a while.
        this.ignoreId[i] = id;
        this.ignoreTimer[i] = FEEDING.ignoreS;
        this.drop(i);
        this.retarget[i] = 0;
      }
    }

    for (let i = 0; i < n; i++) {
      if (at(this.retarget, i) > 0 || !this.hungry(i) || at(this.handling, i) > 0) continue;
      if (at(this.target, i) >= 0 && food.feeders(at(this.target, i)) > 1) continue;
      this.retarget[i] = FEEDING.retargetS;
      this.looked[i] = 1;
      const k = this.choose(i, false);
      if (k < 0) continue;
      const score = this.chosenScore;
      const current = at(this.target, i);
      if (current === k) {
        this.targetScore[i] = score;
      } else if (current < 0 || score > FEEDING.switchRatio * at(this.targetScore, i)) {
        this.aim(i, k, score);
      }
    }

    this.resolve();
    this.bite();
    this.followFeeders();
  }

  /** Clears targets; the next update starts from scratch (used when food is replaced wholesale). */
  private drop(i: number): void {
    this.target[i] = -1;
    this.targetId[i] = -1;
    this.targetScore[i] = 0;
    this.pursuit[i] = 0;
    this.follow[i] = -1;
  }

  private aim(i: number, k: number, score: number): void {
    this.target[i] = k;
    this.targetId[i] = at(this.host.food.id, k);
    this.targetScore[i] = score;
    this.pursuit[i] = 0;
    this.follow[i] = -1;
  }

  private hungry(i: number): boolean {
    return this.eligible[i] === 1 && this.motivation(i) > FEEDING.satiatedMotivation;
  }

  private withinLeash(i: number, x: number, y: number, z: number): boolean {
    const o = i * 4;
    const r = at(this.leash, o + 3);
    if (r === Infinity) return true;
    return (
      Math.hypot(x - at(this.leash, o), y - at(this.leash, o + 1), z - at(this.leash, o + 2)) <= r
    );
  }

  /** A pursued particle is followed out to a wider range and outside the visual cone. */
  private keeps(i: number, k: number): boolean {
    const { food, position } = this.host;
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp === undefined) return false;
    const x = at(food.position, k * 3);
    const y = at(food.position, k * 3 + 1);
    const z = at(food.position, k * 3 + 2);
    const d = Math.hypot(
      x - at(position, i * 3),
      y - at(position, i * 3 + 1),
      z - at(position, i * 3 + 2),
    );
    return d <= sp.perceptionRange * FEEDING.keepRangeFactor && this.withinLeash(i, x, y, z);
  }

  /**
   * How strongly food at height `y` over sand at `ground` draws a fish: full inside its depth band, fading to
   * `zoneEdgeSalience` at `zoneReach` of the water column beyond it, nothing further out. Bottom
   * foragers reach up less far: they wait for food to sink to them.
   */
  private zone(i: number, y: number, ground: number): number {
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp === undefined) return 0;
    const u = (y - ground) / (this.host.basin.maxY - ground);
    const outside = Math.max(sp.depthLow - u, u - sp.depthHigh, 0);
    const reach = sp.gait === 'forage' ? FEEDING.bottomZoneReach : FEEDING.zoneReach;
    if (outside > reach) return 0;
    return 1 - (1 - FEEDING.zoneEdgeSalience) * (outside / reach);
  }

  /**
   * Best particle in fish `i`'s perception cone by salience × diet preference. With `contested`,
   * particles already claimed by as many fish as can feed on them, all nearer than `i`, are
   * skipped. Returns the particle index or -1, and leaves its score in `chosenScore`.
   */
  private choose(i: number, contested: boolean): number {
    const { food, bodyLength, basin } = this.host;
    this.unreachableCount = 0;
    for (;;) {
      const k = this.best(i, contested);
      if (k < 0) return -1;
      const y = feedingHeight(
        at(food.position, k * 3 + 1),
        at(bodyLength, i),
        at(food.ground, k),
        basin.maxY,
      );
      if (this.host.canTurnAt(i, at(food.position, k * 3), y, at(food.position, k * 3 + 2))) {
        return k;
      }
      // Food at the blind end of a slot too narrow to turn in: a fish that noses in after it
      // can neither turn nor see the way back, so it is passed over like food it cannot see.
      if (this.unreachableCount === FEEDING.reachChecks) {
        this.chosenScore = 0;
        return -1;
      }
      this.unreachable[this.unreachableCount++] = k;
    }
  }

  private isUnreachable(k: number): boolean {
    for (let m = 0; m < this.unreachableCount; m++) {
      if (this.unreachable[m] === k) return true;
    }
    return false;
  }

  private best(i: number, contested: boolean): number {
    const { food, position, forward } = this.host;
    this.chosenScore = 0;
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp === undefined) return -1;
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    const fx = at(forward, i * 3);
    const fy = at(forward, i * 3 + 1);
    const fz = at(forward, i * 3 + 2);
    const range = sp.perceptionRange;
    const cone = sp.perceptionFov >= 2 * Math.PI ? -2 : Math.cos(sp.perceptionFov / 2);
    const motivation = this.motivation(i);
    const found = food.near(px, py, pz, range, this.candidates);
    let best = -1;
    let bestScore = 0;
    for (let m = 0; m < found; m++) {
      const k = at(this.candidates, m);
      const id = at(food.id, k);
      if (id === at(this.ignoreId, i) || this.buried[k] === 1) continue;
      if (this.isUnreachable(k)) continue;
      const preference = at(sp.foodPreference, at(food.type, k));
      if (preference <= 0 || food.remaining(k) <= EMPTY) continue;
      const x = at(food.position, k * 3);
      const y = at(food.position, k * 3 + 1);
      const z = at(food.position, k * 3 + 2);
      const dx = x - px;
      const dy = y - py;
      const dz = z - pz;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-9 && (dx * fx + dy * fy + dz * fz) / d < cone) continue;
      if (!this.withinLeash(i, x, y, z)) continue;
      if (contested && this.full(k, d)) continue;
      const motion = Math.min(1, at(food.speed, k) / FEEDING.motionReferenceMps);
      const salience =
        (1 - d / range) *
        (1 + FEEDING.motionSalienceGain * motion) *
        this.zone(i, y, at(food.ground, k));
      const score = salience * preference * motivation;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (bestScore < FEEDING.minScore) return -1;
    this.chosenScore = bestScore;
    return best;
  }

  private full(k: number, d: number): boolean {
    const count = at(this.claimCount, k);
    if (count < this.host.food.feeders(k)) return false;
    return at(this.claimDist, k * MAX_FEEDERS + count - 1) <= d;
  }

  /**
   * Inserts fish `i` among particle `k`'s claimants, kept nearest first. Returns the fish pushed
   * out (the farthest, possibly `i` itself) or -1.
   */
  private claim(k: number, i: number, d: number): number {
    const cap = this.host.food.feeders(k);
    const o = k * MAX_FEEDERS;
    let count = at(this.claimCount, k);
    let out = -1;
    if (count === cap) {
      if (d >= at(this.claimDist, o + count - 1)) return i;
      out = at(this.claimFish, o + count - 1);
      count--;
    }
    let slot = count;
    while (slot > 0 && at(this.claimDist, o + slot - 1) > d) {
      this.claimDist[o + slot] = at(this.claimDist, o + slot - 1);
      this.claimFish[o + slot] = at(this.claimFish, o + slot - 1);
      slot--;
    }
    this.claimDist[o + slot] = d;
    this.claimFish[o + slot] = i;
    this.claimCount[k] = count + 1;
    return out;
  }

  private distanceTo(i: number, k: number): number {
    const { food, position } = this.host;
    return Math.hypot(
      at(food.position, k * 3) - at(position, i * 3),
      at(food.position, k * 3 + 1) - at(position, i * 3 + 1),
      at(food.position, k * 3 + 2) - at(position, i * 3 + 2),
    );
  }

  /**
   * Competition: of the fish going for one particle, the nearest (as many as can share it) keep
   * it and the rest retarget, skipping particles held by nearer fish. A few rounds settle chains
   * of displacement; a fish still without food tries again next step.
   */
  private resolve(): void {
    const n = this.host.count;
    this.claimCount.fill(0, 0, this.host.food.count);
    let lost = 0;
    for (let i = 0; i < n; i++) {
      const k = at(this.target, i);
      if (k < 0) continue;
      const out = this.claim(k, i, this.distanceTo(i, k));
      if (out >= 0) this.lost[lost++] = out;
    }
    for (let round = 0; round < FEEDING.resolveRounds && lost > 0; round++) {
      let next = 0;
      for (let m = 0; m < lost; m++) {
        const i = at(this.lost, m);
        this.drop(i);
        const k = this.choose(i, true);
        if (k < 0) continue;
        this.aim(i, k, this.chosenScore);
        const out = this.claim(k, i, this.distanceTo(i, k));
        if (out >= 0) this.lostNext[next++] = out;
      }
      for (let m = 0; m < next; m++) this.lost[m] = at(this.lostNext, m);
      lost = next;
    }
    for (let m = 0; m < lost; m++) {
      const i = at(this.lost, m);
      this.drop(i);
      this.retarget[i] = 0;
    }
  }

  /** Whether particle `k` is an attached item rasped in small bites rather than swallowed. */
  grazes(k: number): boolean {
    return this.host.food.feeders(k) > 1;
  }

  private bite(): void {
    const { food, position, forward, bodyLength, fishIds, basin } = this.host;
    for (let i = 0; i < this.host.count; i++) {
      const k = at(this.target, i);
      if (k < 0 || at(this.handling, i) > 0) continue;
      const length = at(bodyLength, i);
      const mouth = FEEDING.mouthBodyLengths * length;
      const d = Math.hypot(
        at(food.position, k * 3) - (at(position, i * 3) + at(forward, i * 3) * mouth),
        feedingHeight(at(food.position, k * 3 + 1), length, at(food.ground, k), basin.maxY) -
          (at(position, i * 3 + 1) + at(forward, i * 3 + 1) * mouth),
        at(food.position, k * 3 + 2) - (at(position, i * 3 + 2) + at(forward, i * 3 + 2) * mouth),
      );
      if (d > FEEDING.biteReachBodyLengths * length) continue;
      const grazed = this.grazes(k);
      const room = FEEDING.satiationPortions - at(this.gut, i);
      const portion = Math.min(
        food.remaining(k),
        room,
        grazed ? FEEDING.grazeBitePortion : Infinity,
      );
      if (portion <= EMPTY) {
        this.drop(i);
        continue;
      }
      food.consume(k, portion);
      this.gut[i] = at(this.gut, i) + portion;
      const fishId = fishIds[i];
      if (fishId !== undefined) this.events.push({ fishId, foodId: at(food.id, k), portion });
      this.handling[i] = grazed ? FEEDING.grazeBiteS : FEEDING.handlingS;
      this.pursuit[i] = 0;
      if (!grazed || food.remaining(k) <= EMPTY || !this.hungry(i)) this.drop(i);
    }
  }

  /**
   * Local enhancement: a hungry fish that sees no food itself swims to a nearby fish that is
   * feeding (Pitcher, Magurran & Winfield 1982).
   */
  private followFeeders(): void {
    const { distSq, count, position } = this.host;
    for (let i = 0; i < count; i++) {
      if (at(this.target, i) >= 0 || !this.hungry(i) || at(this.handling, i) > 0) {
        this.follow[i] = -1;
        continue;
      }
      const sp = this.host.species[at(this.host.speciesIndex, i)];
      if (sp === undefined) continue;
      const range2 = sp.perceptionRange * sp.perceptionRange;
      const current = at(this.follow, i);
      if (current >= 0) {
        const still =
          at(this.target, current) >= 0 &&
          at(distSq, i * count + current) <= range2 &&
          this.withinLeash(
            i,
            at(position, current * 3),
            at(position, current * 3 + 1),
            at(position, current * 3 + 2),
          );
        if (still) continue;
        this.follow[i] = -1;
      }
      if (this.looked[i] !== 1) continue;
      const found = selectNearest(
        distSq,
        count,
        i,
        FEEDING.followNeighbours,
        null,
        range2,
        this.nbr,
        0,
        this.nbrDist,
      );
      for (let m = 0; m < found; m++) {
        const j = at(this.nbr, m);
        if (at(this.target, j) < 0) continue;
        if (
          !this.withinLeash(
            i,
            at(position, j * 3),
            at(position, j * 3 + 1),
            at(position, j * 3 + 2),
          )
        ) {
          continue;
        }
        this.follow[i] = j;
        break;
      }
    }
  }
}
