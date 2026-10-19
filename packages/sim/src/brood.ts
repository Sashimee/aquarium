import type { FishSex, FishStage } from '@aquarium/shared';
import type { BehaviourHost, Plan } from './behaviour.ts';
import type { Point3 } from './decor.ts';
import { FEEDING } from './feeding.ts';
import type { FishResize } from './fishArrays.ts';
import { clamp } from './math.ts';
import { FishState } from './snapshot.ts';

/** Every tunable of egg tending, pregnancy and the young; sources are in BEHAVIOUR.md. */
export const BROOD = {
  maxClutches: 16,

  /** Long-run share of time at the clutch: anemonefish fathers and mothers. */
  nestShareMale: 0.55,
  nestShareFemale: 0.25,
  /** Biparental tenders without a known division of labour share it equally. */
  nestShareEqual: 0.5,
  nestBoutMeanS: 60,
  /** Bout lengths are drawn uniformly within this fraction either side of their mean. */
  boutJitter: 0.5,
  fanBoutMinS: 3,
  fanBoutMaxS: 12,
  mouthBoutMinS: 1,
  mouthBoutMaxS: 3,
  /** Chance that a fanning bout is followed by mouthing rather than more fanning. */
  mouthShare: 0.3,
  /** Snout clear of the eggs while fanning, so the pectorals sit over them. */
  fanStandoffBodyLengths: 0.15,
  mouthStandoffBodyLengths: 0.03,
  /** Within this of its hover point a parent counts as at the nest. */
  atNestBodyLengths: 1,
  /** A guarding parent away from the eggs stays within this many of its lengths of them. */
  guardBodyLengths: 4,
  tendSpeedFactor: 0.6,
  fanTauS: 0.3,
  /** A surface steeper than this (horizontal share of its normal) is faced; a flatter one hovered over. */
  wallNormal: 0.5,

  nestCandidates: 32,
  nestProjectPasses: 4,
  nestSurfaceM: 0.002,
  nestRoomBodyLengths: 0.75,
  /** Rock is taken over sand or glass within this many body lengths farther from home. */
  nestRockPreferenceBodyLengths: 6,

  /** Fast-start and cruising performance lost at full term. */
  gravidSpeedLoss: 0.3,
  /** From this far into pregnancy a female keeps to cover and away from the shoal. */
  gravidCoverTerm: 0.85,
  gravidSchoolFactor: 0,

  coverCandidates: 12,
  coverMinS: 30,
  coverMaxS: 90,
  /** Hiding spots are this far, in the fish's lengths plus its radius, from a plant or rock. */
  coverOffsetBodyLengths: 0.5,
  coverRadiusBodyLengths: 1.5,
  hideWander: 0.3,
  /** A hider returns to its spot at no more than its distance over this many seconds. */
  hideApproachS: 2,
  coverTravelWeight: 0.2,
  fryLeashBodyLengths: 12,
  fryCohesion: 0.3,
  /** A fish this many times a young fish's length or more is a threat to it. */
  predatorLengthRatio: 2,
  /** How far, in the threat's lengths, a young fish keeps from it. */
  shunBodyLengths: 1.5,
  shunWeight: 2,
} as const;

/** Per-fish stage codes in `BehaviourHost.stage`. */
export const StageCode = { Adult: 0, Juvenile: 1, Fry: 2 } as const;
/** Per-fish sex codes in `BehaviourHost.sex`. */
export const SexCode = { Unknown: 0, Male: 1, Female: 2 } as const;

export function stageCode(stage: FishStage | undefined): number {
  return stage === 'fry' ? StageCode.Fry : stage === 'juvenile' ? StageCode.Juvenile : 0;
}

export function sexCode(sex: FishSex | undefined): number {
  return sex === 'male' ? SexCode.Male : sex === 'female' ? SexCode.Female : SexCode.Unknown;
}

/** Eggs laid on a surface: `position` lies on rock, sand or glass, as `World.nestSite` gives. */
export interface SimClutch {
  readonly id: string;
  /** The fish that guard and fan the eggs; usually the spawning pair. */
  readonly parents: readonly string[];
  readonly position: Point3;
}

/** A pregnant livebearer and how far along she is, 0 at conception to 1 at the drop. */
export interface SimGravid {
  readonly fishId: string;
  readonly term: number;
}

export interface SimBrood {
  readonly clutches: readonly SimClutch[];
  readonly gravid: readonly SimGravid[];
}

export const NestPhase = { None: 0, Away: 1, Fan: 2, Mouth: 3 } as const;

interface Clutch {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

const DT = 1 / 30;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * Parental care and the young. Parents of a clutch alternate bouts at the eggs, fanning them and
 * now and then mouthing them, with bouts away; how long each spends there follows its sex. A
 * pregnant livebearer slows as her term advances and near it keeps to cover away from the shoal.
 * Fry hide by plants or rock and shift their spot now and then, feed only near it, and keep away
 * from any fish twice their length; juveniles leave cover but still shun big fish. Young school
 * with their own kind's young only. `Behaviour` turns this into plans. The RNG is drawn only for
 * parents of a clutch, fry and near-term females, so a tank without any is unchanged by it.
 */
export class Brood {
  private _clutchOf: Int32Array;
  private _nestPhase: Uint8Array;
  private nestTimer: Float64Array;
  private boutTimer: Float64Array;
  private nestShare: Float64Array;
  private _gravid: Float64Array;
  private _cover: Float64Array;
  private coverTimer: Float64Array;
  private _fan: Float64Array;

  private readonly host: BehaviourHost;
  private clutches: readonly Clutch[] = [];
  private parents: readonly (readonly string[])[] = [];
  private readonly n3 = new Float64Array(3);

  /** Index into the clutches of the clutch each fish tends, or -1. */
  get clutchOf(): Int32Array {
    return this._clutchOf;
  }

  /** Each fish's `NestPhase`. */
  get nestPhase(): Uint8Array {
    return this._nestPhase;
  }

  /** Each fish's term, 0 when not pregnant. */
  get gravid(): Float64Array {
    return this._gravid;
  }

  /** Per fish x, y, z of the hiding spot it holds; meaningful once `coverHeld` says so. */
  get cover(): Float64Array {
    return this._cover;
  }

  /** 0 to 1 per fish: pectoral fanning over a clutch, eased in and out. */
  get fan(): Float64Array {
    return this._fan;
  }

  get clutchCount(): number {
    return this.clutches.length;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._clutchOf = new Int32Array(n).fill(-1);
    this._nestPhase = new Uint8Array(n);
    this.nestTimer = new Float64Array(n);
    this.boutTimer = new Float64Array(n);
    this.nestShare = new Float64Array(n);
    this._gravid = new Float64Array(n);
    this._cover = new Float64Array(n * 3);
    this.coverTimer = new Float64Array(n);
    this._fan = new Float64Array(n);
  }

  /** A fish that left takes its place at its clutch and its pregnancy with it. */
  resize(edit: FishResize): void {
    this._clutchOf = edit.array(this.clutchOf, 1, -1);
    this._nestPhase = edit.array(this.nestPhase);
    this.nestTimer = edit.array(this.nestTimer);
    this.boutTimer = edit.array(this.boutTimer);
    this.nestShare = edit.array(this.nestShare);
    this._gravid = edit.array(this.gravid);
    this._cover = edit.array(this.cover, 3);
    this.coverTimer = edit.array(this.coverTimer);
    this._fan = edit.array(this.fan);
    if (edit.removed < 0) return;
    // The ids stay right; `setBrood` matches by them, so a parent that left is simply not found.
    this.parents = this.parents.map((ids) => ids.filter((id) => this.host.fishIds.includes(id)));
  }

  /**
   * Replaces the clutches and pregnancies. A parent whose clutch keeps its id carries on its bout;
   * one given a new clutch starts afresh. Throws, changing nothing, on malformed input: an unknown
   * or repeated fish, a parent of two clutches, a fry or juvenile as parent or mother, a walker,
   * or a clutch outside the tank.
   */
  setBrood(brood: SimBrood): void {
    const { clutches, parents, owner, terms } = this.parse(brood);
    const n = this.host.count;
    const before = this.clutches;
    for (let i = 0; i < n; i++) {
      const k = at(owner, i);
      const old = at(this.clutchOf, i);
      if (k < 0 || old < 0 || before[old]?.id !== clutches[k]?.id) {
        this.nestPhase[i] = NestPhase.None;
      }
      this.clutchOf[i] = k;
      const term = at(terms, i);
      if (term < BROOD.gravidCoverTerm && at(this.host.stage, i) !== StageCode.Fry) {
        this.coverTimer[i] = 0;
      }
      this.gravid[i] = term;
    }
    this.nestShare.fill(0);
    clutches.forEach((_, k) => this.divideCare(k, parents[k] ?? [], owner));
    this.clutches = clutches;
    this.parents = parents;
  }

  /**
   * The current input in `setBrood`'s form, with parents that left the tank dropped, and a clutch
   * none of whose parents is left dropped with them, so it can be passed back to `setBrood`.
   */
  brood(): SimBrood {
    const ids = this.host.fishIds;
    return {
      clutches: this.clutches.flatMap((c, k) => {
        const parents = this.parents[k] ?? [];
        return parents.length === 0 ? [] : [{ id: c.id, parents, position: [c.x, c.y, c.z] }];
      }),
      gravid: ids.flatMap((fishId, i) => {
        const term = at(this.gravid, i);
        return term > 0 ? [{ fishId, term }] : [];
      }),
    };
  }

  private parse(brood: SimBrood): {
    clutches: Clutch[];
    parents: string[][];
    owner: Int32Array;
    terms: Float64Array;
  } {
    if (typeof brood !== 'object' || brood === null) {
      throw new TypeError('brood: expected { clutches, gravid }');
    }
    const { clutches: inClutches, gravid: inGravid } = brood;
    if (!Array.isArray(inClutches) || !Array.isArray(inGravid)) {
      throw new TypeError('brood: clutches and gravid must be arrays');
    }
    if (inClutches.length > BROOD.maxClutches) {
      throw new RangeError(
        `brood: at most ${BROOD.maxClutches} clutches, got ${inClutches.length}`,
      );
    }
    const n = this.host.count;
    const owner = new Int32Array(n).fill(-1);
    const terms = new Float64Array(n);
    const clutchIds = new Set<string>();
    const clutches: Clutch[] = [];
    const parents: string[][] = [];
    inClutches.forEach((c: SimClutch, k) => {
      const id: unknown = c?.id;
      if (typeof id !== 'string' || id === '') {
        throw new RangeError(`brood: clutch ${k} needs a non-empty string id`);
      }
      if (clutchIds.has(id)) throw new RangeError(`brood: clutch id "${id}" repeats`);
      clutchIds.add(id);
      const [x, y, z] = this.surfacePoint(c.position, id);
      if (!Array.isArray(c.parents) || c.parents.length === 0) {
        throw new RangeError(`brood: clutch "${id}" needs at least one parent`);
      }
      const ids: string[] = [];
      for (const p of c.parents as readonly unknown[]) {
        const i = this.adult(p, `clutch "${id}" parent`);
        if (at(owner, i) >= 0) {
          throw new RangeError(`brood: fish "${String(p)}" is a parent of two clutches`);
        }
        owner[i] = k;
        ids.push(String(p));
      }
      const normal = this.n3;
      this.host.substrateSdf.sample(x, y, z, normal);
      clutches.push({ id, x, y, z, nx: at(normal, 0), ny: at(normal, 1), nz: at(normal, 2) });
      parents.push(ids);
    });
    const mothers = new Set<number>();
    inGravid.forEach((g: SimGravid, k) => {
      const i = this.adult(g?.fishId, `gravid ${k}`);
      if (mothers.has(i)) throw new RangeError(`brood: fish "${String(g.fishId)}" is gravid twice`);
      mothers.add(i);
      const term: unknown = g.term;
      if (typeof term !== 'number' || !(term >= 0 && term <= 1)) {
        throw new RangeError(
          `brood: gravid fish "${String(g.fishId)}" needs a term within 0 to 1, got ${String(term)}`,
        );
      }
      terms[i] = term;
    });
    return { clutches, parents, owner, terms };
  }

  private adult(id: unknown, what: string): number {
    const i = typeof id === 'string' ? this.host.fishIds.indexOf(id) : -1;
    if (i < 0) throw new RangeError(`brood: ${what} "${String(id)}" is not in the tank`);
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp?.walking !== null) throw new RangeError(`brood: ${what} "${id as string}" is a walker`);
    if (at(this.host.stage, i) !== StageCode.Adult) {
      throw new RangeError(`brood: ${what} "${id as string}" is not an adult`);
    }
    return i;
  }

  private surfacePoint(p: unknown, id: string): Point3 {
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      !p.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      throw new RangeError(`brood: clutch "${id}" position must be a finite [x, y, z] array`);
    }
    const [x, y, z] = p as [number, number, number];
    const b = this.host.basin;
    const slack = BROOD.nestSurfaceM;
    const inside =
      x >= b.minX - slack &&
      x <= b.maxX + slack &&
      z >= b.minZ - slack &&
      z <= b.maxZ + slack &&
      y >= b.ground(x, z) - slack &&
      y < b.maxY;
    if (!inside) throw new RangeError(`brood: clutch "${id}" lies outside the tank`);
    return [x, y, z];
  }

  /**
   * Anemonefish fathers do most of the tending; without sexes the pair's larger fish is the
   * female, as anemonefish change sex from male to female as they grow.
   */
  private divideCare(k: number, ids: readonly string[], owner: Int32Array): void {
    const { fishIds, sex, bodyLength, speciesIndex, species } = this.host;
    const members = ids.map((id) => fishIds.indexOf(id)).filter((i) => at(owner, i) === k);
    const anemone = members.some((i) => species[at(speciesIndex, i)]?.home === 'anemone');
    let female = -1;
    if (anemone && members.length >= 2 && members.every((i) => at(sex, i) === SexCode.Unknown)) {
      for (const i of members) {
        if (female < 0 || at(bodyLength, i) > at(bodyLength, female)) female = i;
      }
    }
    for (const i of members) {
      const s = at(sex, i);
      let share: number = BROOD.nestShareEqual;
      if (anemone && (s === SexCode.Female || i === female)) share = BROOD.nestShareFemale;
      else if (anemone && (s === SexCode.Male || female >= 0)) share = BROOD.nestShareMale;
      this.nestShare[i] = share;
    }
  }

  /** Advances nest bouts and the young's and near-term mothers' hiding spots. */
  update(): void {
    const { rng } = this.host;
    for (let i = 0; i < this.host.count; i++) {
      if (at(this.clutchOf, i) >= 0) this.advanceNest(i);
      if (this.hides(i)) {
        const left = at(this.coverTimer, i) - DT;
        if (left <= 0) {
          this.chooseCover(i);
          this.coverTimer[i] = rng.range(BROOD.coverMinS, BROOD.coverMaxS);
        } else {
          this.coverTimer[i] = left;
        }
      }
    }
  }

  private advanceNest(i: number): void {
    const { rng } = this.host;
    const share = at(this.nestShare, i);
    const jitter = (): number => 1 + BROOD.boutJitter * rng.signed();
    const nestBout = (): number => BROOD.nestBoutMeanS * jitter();
    const awayBout = (): number => ((BROOD.nestBoutMeanS * (1 - share)) / share) * jitter();
    const phase = at(this.nestPhase, i);
    if (phase === NestPhase.None) {
      const home = rng.next() < share;
      this.nestPhase[i] = home ? NestPhase.Fan : NestPhase.Away;
      this.nestTimer[i] = home ? nestBout() : awayBout();
      this.boutTimer[i] = rng.range(BROOD.fanBoutMinS, BROOD.fanBoutMaxS);
      return;
    }
    const left = at(this.nestTimer, i) - DT;
    if (left <= 0) {
      const home = phase === NestPhase.Away;
      this.nestPhase[i] = home ? NestPhase.Fan : NestPhase.Away;
      this.nestTimer[i] = home ? nestBout() : awayBout();
      this.boutTimer[i] = rng.range(BROOD.fanBoutMinS, BROOD.fanBoutMaxS);
      return;
    }
    this.nestTimer[i] = left;
    if (phase === NestPhase.Away) return;
    const bout = at(this.boutTimer, i) - DT;
    if (bout > 0) {
      this.boutTimer[i] = bout;
      return;
    }
    const mouth = phase === NestPhase.Fan && rng.next() < BROOD.mouthShare;
    this.nestPhase[i] = mouth ? NestPhase.Mouth : NestPhase.Fan;
    this.boutTimer[i] = mouth
      ? rng.range(BROOD.mouthBoutMinS, BROOD.mouthBoutMaxS)
      : rng.range(BROOD.fanBoutMinS, BROOD.fanBoutMaxS);
  }

  /** Whether fish `i` keeps to a hiding spot: fry, and mothers near term. */
  hides(i: number): boolean {
    return at(this.host.stage, i) === StageCode.Fry || at(this.gravid, i) >= BROOD.gravidCoverTerm;
  }

  /** A young fish, which schools with young of its kind only and keeps away from big fish. */
  young(i: number): boolean {
    return at(this.host.stage, i) !== StageCode.Adult;
  }

  /** Busy with brood: at the eggs, hiding or near term, so with no attention for lures or toys. */
  busy(i: number): boolean {
    const phase = at(this.nestPhase, i);
    return phase === NestPhase.Fan || phase === NestPhase.Mouth || this.hides(i);
  }

  /** The clutch fish `i` tends, or null. */
  clutchPoint(i: number): Point3 | null {
    const c = this.clutches[at(this.clutchOf, i)];
    return c === undefined ? null : [c.x, c.y, c.z];
  }

  /** Slows a pregnant fish, loosens a near-term one from the shoal and a fry from its fellows. */
  adjust(i: number, plan: Plan): void {
    const term = at(this.gravid, i);
    if (term > 0) {
      plan.cruiseScale *= 1 - BROOD.gravidSpeedLoss * term;
      if (term >= BROOD.gravidCoverTerm) {
        plan.align *= BROOD.gravidSchoolFactor;
        plan.cohesion *= BROOD.gravidSchoolFactor;
      }
    }
    if (at(this.host.stage, i) === StageCode.Fry) plan.cohesion *= BROOD.fryCohesion;
  }

  /**
   * A parent on a nest bout hovers at its clutch: fanning, its snout just clear of the eggs and
   * its pectorals over them, or mouthing, with its mouth on them. A clutch on a wall or rock face
   * is faced from open water; one on the sand or a rock top is hovered over.
   */
  planTend(i: number, plan: Plan): boolean {
    const phase = at(this.nestPhase, i);
    if (phase !== NestPhase.Fan && phase !== NestPhase.Mouth) return false;
    const c = this.clutches[at(this.clutchOf, i)];
    if (c === undefined) return false;
    const { position } = this.host;
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    const gap =
      phase === NestPhase.Fan ? BROOD.fanStandoffBodyLengths : BROOD.mouthStandoffBodyLengths;
    const reach = (FEEDING.mouthBodyLengths + gap) * length;
    const wall = Math.hypot(c.nx, c.nz) >= BROOD.wallNormal;
    let tx = c.x;
    let ty = c.y;
    let tz = c.z;
    if (wall) {
      plan.arrival = reach;
    } else {
      tx += c.nx * reach;
      ty += c.ny * reach;
      tz += c.nz * reach;
    }
    const d = wall
      ? Math.max(0, Math.hypot(c.x - px, c.y - py, c.z - pz) - reach)
      : Math.hypot(tx - px, ty - py, tz - pz);
    plan.align = 0;
    plan.cohesion = 0;
    plan.wander = 0;
    plan.continuous = true;
    plan.speedFloor = 0;
    plan.comfort = FEEDING.approachComfort;
    plan.bandLo = Math.min(plan.bandLo, ty - length);
    plan.bandHi = Math.max(plan.bandHi, ty + length);
    const speed = BROOD.tendSpeedFactor * cruise;
    plan.seek(tx, ty, tz, Math.max(speed, Math.min(cruise, d / 2)), 0.5);
    plan.speedCap = Math.max(speed * clamp(d / length, 0.1, 1), Math.min(cruise, d / 2));
    plan.pivot = d < length;
    if (d < BROOD.atNestBodyLengths * length) {
      plan.state = FishState.Tend;
      plan.fan = phase === NestPhase.Fan ? 1 : 0;
      if (!wall) {
        const h = Math.hypot(c.x - px, c.z - pz);
        plan.pitch = -Math.atan2(Math.max(0, py - c.y), Math.max(h, 0.5 * length)) * 0.5;
      }
    }
    return true;
  }

  /** Away from the eggs, a parent with no anemone or cave keeps watch near them. */
  guard(i: number): Point3 | null {
    if (at(this.nestPhase, i) !== NestPhase.Away) return null;
    return this.clutchPoint(i);
  }

  /** Eases the fan output toward this step's plan. */
  ease(i: number, plan: Plan): void {
    const f = at(this.fan, i);
    if (f === 0 && plan.fan === 0) return;
    const next = f + (plan.fan - f) * (1 - Math.exp(-DT / BROOD.fanTauS));
    this.fan[i] = plan.fan === 0 && next < 1e-4 ? 0 : next;
  }

  /** Keeps a young fish away from the nearest fish of twice its length or more. */
  shunPredator(i: number, plan: Plan): void {
    if (!this.young(i)) return;
    const { count, distSq, bodyLength, position, species, speciesIndex } = this.host;
    const li = at(bodyLength, i);
    const min = BROOD.predatorLengthRatio * li;
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      const lj = at(bodyLength, j);
      if (lj < min || species[at(speciesIndex, j)]?.walking !== null) continue;
      const d = at(distSq, i * count + j);
      const r = BROOD.shunBodyLengths * lj;
      if (d < r * r && d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) return;
    plan.shun(
      at(position, best * 3),
      at(position, best * 3 + 1),
      at(position, best * 3 + 2),
      BROOD.shunBodyLengths * at(bodyLength, best),
      BROOD.shunWeight,
    );
  }

  /**
   * A hiding spot clear of everything: beside a plant if the tank has any, else beside rock,
   * else against the glass or sand, inside the fish's band and not far from where it is. Random
   * points in the band are drawn onto the cover's offset surface, as thin stems are rarely hit.
   */
  private chooseCover(i: number): void {
    const { basin, rng, sceneSdf, decorSdf, plantSdf, position } = this.host;
    const length = at(this.host.bodyLength, i);
    const radius = at(this.host.radius, i);
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp === undefined) throw new RangeError(`no fish at index ${i}`);
    const margin = radius + BROOD.coverOffsetBodyLengths * length;
    const cover = plantSdf ?? decorSdf ?? sceneSdf;
    const n3 = this.n3;
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    let best = Infinity;
    let bx = px;
    let by = py;
    let bz = pz;
    for (let c = 0; c < BROOD.coverCandidates; c++) {
      let x = rng.range(basin.minX + margin, basin.maxX - margin);
      const t = rng.next();
      let z = rng.range(basin.minZ + margin, basin.maxZ - margin);
      const g = basin.ground(x, z);
      const h = basin.maxY - g;
      const yLo = Math.max(g + sp.depthLow * h, g + margin);
      const yHi = Math.max(yLo, Math.min(g + sp.depthHigh * h, basin.maxY - margin));
      let y = yLo + (yHi - yLo) * t;
      for (let pass = 0; pass < BROOD.nestProjectPasses; pass++) {
        const d = cover.sample(x, y, z, n3) - margin;
        x = clamp(x - at(n3, 0) * d, basin.minX + margin, basin.maxX - margin);
        y = clamp(y - at(n3, 1) * d, yLo, yHi);
        z = clamp(z - at(n3, 2) * d, basin.minZ + margin, basin.maxZ - margin);
      }
      if (y < basin.ground(x, z) + margin) continue;
      if (sceneSdf.sample(x, y, z, n3) < margin) continue;
      if (plantSdf !== null && plantSdf.sample(x, y, z, n3) < radius) continue;
      const off = Math.abs(cover.sample(x, y, z, n3) - margin);
      const score = off + BROOD.coverTravelWeight * Math.hypot(x - px, y - py, z - pz);
      if (score < best) {
        best = score;
        bx = x;
        by = y;
        bz = z;
      }
    }
    this.cover[i * 3] = bx;
    this.cover[i * 3 + 1] = by;
    this.cover[i * 3 + 2] = bz;
  }

  /** Feeding range of a fry around its cover, written as the feeding layer's leash. */
  fryLeash(i: number, leash: Float64Array): boolean {
    if (at(this.host.stage, i) !== StageCode.Fry) return false;
    const o = i * 4;
    leash[o] = at(this.cover, i * 3);
    leash[o + 1] = at(this.cover, i * 3 + 1);
    leash[o + 2] = at(this.cover, i * 3 + 2);
    leash[o + 3] = BROOD.fryLeashBodyLengths * at(this.host.bodyLength, i);
    return true;
  }

  /**
   * Where anemonefish parents spawn: bare rock or another hard surface beside their home, with
   * room for a parent to hover over it. Candidates on a sphere round `home` are dropped onto the
   * nearest surface; rock is preferred over sand and glass unless much farther, and then the spot
   * nearest home. Deterministic and draws no RNG.
   */
  nestSite(hx: number, hy: number, hz: number, reach: number, length: number): Point3 | null {
    const { basin, substrateSdf, decorSdf, plantSdf, sceneSdf } = this.host;
    const n3 = this.n3;
    const k = BROOD.nestCandidates;
    const room = BROOD.nestRoomBodyLengths * length;
    let best: Point3 | null = null;
    let bestScore = Infinity;
    for (let c = 0; c < k; c++) {
      const cy = 1 - (2 * (c + 0.5)) / k;
      const r = Math.sqrt(1 - cy * cy);
      const a = c * 2.399963;
      let x = hx + Math.cos(a) * r * reach;
      let y = hy + cy * reach;
      let z = hz + Math.sin(a) * r * reach;
      for (let pass = 0; pass < BROOD.nestProjectPasses; pass++) {
        const d = substrateSdf.sample(x, y, z, n3);
        x -= at(n3, 0) * d;
        y -= at(n3, 1) * d;
        z -= at(n3, 2) * d;
      }
      if (Math.abs(substrateSdf.sample(x, y, z, n3)) > BROOD.nestSurfaceM) continue;
      if (x < basin.minX || x > basin.maxX || z < basin.minZ || z > basin.maxZ) continue;
      if (y >= basin.maxY - room) continue;
      const nx = at(n3, 0);
      const ny = at(n3, 1);
      const nz = at(n3, 2);
      if (sceneSdf.sample(x + nx * room, y + ny * room, z + nz * room, n3) < 0.5 * room) continue;
      if (plantSdf !== null && plantSdf.sample(x, y, z, n3) < 0) continue;
      const rock = decorSdf !== null && decorSdf.sample(x, y, z, n3) < BROOD.nestSurfaceM;
      const score =
        Math.hypot(x - hx, y - hy, z - hz) +
        (rock ? 0 : BROOD.nestRockPreferenceBodyLengths * length);
      if (score < bestScore) {
        bestScore = score;
        best = [x, y, z];
      }
    }
    return best;
  }
}
