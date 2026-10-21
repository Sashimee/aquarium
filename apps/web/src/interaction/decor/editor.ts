import { legacyTintSeed, type Biome, type DecorItem } from '@aquarium/shared';
import { SURFACE_MARGIN } from '../../scene/plants';
import { footprintOf, rayHit, type RayLike } from './footprint';
import type { Piece } from './layout';
import {
  admit,
  check,
  describeRejection,
  findFreeSpot,
  keepInside,
  LIFT,
  restHeight,
  MIN_PLANT_SCALE,
  withinServerBounds,
  type GroundHeight,
  type Obstacle,
  type Rejection,
  type TankLimits,
} from './rules';
import { startDrop, stepDrop, type DropBody } from './settle';
import { VACATION_FEEDER_ASSET_ID, type DecorSpec } from './spec';

interface Drag {
  readonly id: string;
  readonly before: Piece;
  readonly grabDx: number;
  readonly grabDz: number;
  valid: boolean;
}

export type DropResult = 'moved' | 'unchanged' | 'reverted';

const ROTATION_LIMIT = Math.PI;
const NEW_PIECE_DROP_HEIGHT = 0.18;
const DEFAULT_SPAWN: readonly [number, number] = [0, 0.05];

const mm = (v: number) => Math.round(v * 1000) / 1000;

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > ROTATION_LIMIT) r -= twoPi;
  if (r < -ROTATION_LIMIT) r += twoPi;
  return Math.round(r * 1000) / 1000;
}

/** Pins the colour at the placement the player first sees, so later moves cannot change it. */
function seeded(item: DecorItem): DecorItem {
  return item.tintSeed === undefined ? { ...item, tintSeed: legacyTintSeed(item) } : item;
}

/** Plant keys are built from the seed, so a new piece must not share one with any piece in the tank. */
function uniqueSeed(item: DecorItem, taken: ReadonlySet<number>): number {
  let seed = legacyTintSeed(item);
  while (taken.has(seed)) seed = (seed + 1) >>> 0;
  return seed;
}

function tidy(item: DecorItem): DecorItem {
  return withinServerBounds({
    ...item,
    position: [mm(item.position[0]), mm(item.position[1]), mm(item.position[2])],
  });
}

export interface EditorOptions {
  readonly specs: ReadonlyMap<string, DecorSpec>;
  readonly biome: Biome;
  readonly limits: TankLimits;
  readonly ground: GroundHeight;
  readonly pieces: readonly Piece[];
}

/**
 * The rules of decorating, with no rendering in it: what may be grabbed, where it may be put,
 * how it falls into place. The mode drives it from the pointer and shows the result.
 */
export class DecorEditor {
  private list: Piece[];
  private readonly drops = new Map<string, { body: DropBody; restY: number }>();
  private drag: Drag | null = null;
  private seq: number;
  selectedId: string | null = null;
  problem: string | null = null;

  constructor(private readonly options: EditorOptions) {
    this.list = options.pieces.map((p) => ({ ...p, item: seeded(p.item) }));
    this.seq = options.pieces.length;
  }

  get pieces(): readonly Piece[] {
    return this.list;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  get busy(): boolean {
    return this.drag !== null || this.drops.size > 0;
  }

  get hasFeeder(): boolean {
    return this.list.some((p) => p.item.assetId === VACATION_FEEDER_ASSET_ID);
  }

  piece(id: string): Piece | undefined {
    return this.list.find((p) => p.id === id);
  }

  /** The pieces as they will rest, so a layout saved mid-fall already holds the final height. */
  restingPieces(): Piece[] {
    return this.list.map((p) => {
      const drop = this.drops.get(p.id);
      return drop && !this.isDragged(p.id)
        ? {
            id: p.id,
            item: { ...p.item, position: [p.item.position[0], mm(drop.restY), p.item.position[2]] },
          }
        : p;
    });
  }

  select(id: string | null): void {
    this.selectedId = id !== null && this.piece(id) ? id : null;
  }

  pick(ray: RayLike): { id: string; t: number } | null {
    let best: { id: string; t: number } | null = null;
    for (const p of this.list) {
      const spec = this.options.specs.get(p.item.assetId);
      if (!spec) continue;
      const t = rayHit(footprintOf(spec, p.item), ray);
      if (t !== null && (!best || t < best.t)) best = { id: p.id, t };
    }
    return best;
  }

  grab(id: string, hit: { x: number; z: number }): boolean {
    const piece = this.piece(id);
    if (!piece) return false;
    this.drops.delete(id);
    this.selectedId = id;
    this.problem = null;
    this.drag = {
      id,
      before: piece,
      grabDx: hit.x - piece.item.position[0],
      grabDz: hit.z - piece.item.position[2],
      valid: true,
    };
    return true;
  }

  /** Moves the grabbed piece under the pointer; the returned piece is what to draw. */
  dragTo(x: number, z: number): Piece | null {
    const drag = this.drag;
    if (!drag) return null;
    const spec = this.specFor(drag.id);
    const current = this.piece(drag.id);
    if (!spec || !current) return null;
    const moved: DecorItem = keepInside(
      spec,
      { ...current.item, position: [x - drag.grabDx, current.item.position[1], z - drag.grabDz] },
      this.options.limits,
    );
    const rest = restHeight(spec, moved, this.options.ground);
    const lifted = withinServerBounds({
      ...moved,
      position: [moved.position[0], rest + LIFT, moved.position[2]],
    });
    const resting: DecorItem = {
      ...lifted,
      position: [lifted.position[0], rest, lifted.position[2]],
    };
    const reason = check(spec, resting, this.obstaclesExcept(drag.id), this.options.limits);
    drag.valid = reason === null;
    this.problem = reason ? describeRejection(reason) : null;
    return this.replace({ id: drag.id, item: lifted });
  }

  drop(): DropResult | null {
    const drag = this.drag;
    if (!drag) return null;
    this.drag = null;
    const spec = this.specFor(drag.id);
    const current = this.piece(drag.id);
    if (!spec || !current) return null;
    const [bx, , bz] = drag.before.item.position;
    const [cx, , cz] = current.item.position;
    if (!drag.valid) {
      this.replace(drag.before);
      return 'reverted';
    }
    if (Math.hypot(cx - bx, cz - bz) < 1e-4) {
      this.replace(drag.before);
      this.problem = null;
      return 'unchanged';
    }
    this.problem = null;
    this.settle(current, spec);
    return 'moved';
  }

  add(assetId: string): { id: string } | { rejection: Rejection } {
    const spec = this.options.specs.get(assetId);
    const rejection = admit(spec, this.list, this.options.biome);
    if (rejection || !spec) return { rejection: rejection ?? 'unknown-asset' };
    const template: DecorItem = { assetId, position: [0, 0, 0], rotationY: 0, scale: 1 };
    const spot = findFreeSpot(spec, template, DEFAULT_SPAWN, this.obstacles(), this.options.limits);
    if (!spot) {
      this.problem = describeRejection('no-room');
      return { rejection: 'no-room' };
    }
    const fitted = this.fitToWater(spec, spot);
    if (!fitted) {
      this.problem = describeRejection('too-tall');
      return { rejection: 'too-tall' };
    }
    const rest = restHeight(spec, fitted, this.options.ground);
    const dropHeight = this.dropHeightFor(spec, fitted, rest);
    const id = `p${++this.seq}`;
    const placed = tidy({
      ...fitted,
      position: [fitted.position[0], rest + dropHeight, fitted.position[2]],
    });
    const taken = new Set(this.list.map((p) => p.item.tintSeed ?? legacyTintSeed(p.item)));
    const piece: Piece = { id, item: { ...placed, tintSeed: uniqueSeed(placed, taken) } };
    this.list = [...this.list, piece];
    this.drops.set(id, { body: startDrop(piece.item.position[1]), restY: rest });
    this.selectedId = id;
    this.problem = null;
    return { id };
  }

  remove(id: string): boolean {
    if (!this.piece(id)) return false;
    this.list = this.list.filter((p) => p.id !== id);
    this.drops.delete(id);
    if (this.drag?.id === id) this.drag = null;
    if (this.selectedId === id) this.selectedId = null;
    this.problem = null;
    return true;
  }

  rotate(id: string, radians: number): boolean {
    const piece = this.piece(id);
    const spec = this.specFor(id);
    if (!piece || !spec) return false;
    const turned: DecorItem = {
      ...piece.item,
      rotationY: wrapAngle(piece.item.rotationY + radians),
    };
    return this.tryChange(piece, spec, keepInside(spec, turned, this.options.limits));
  }

  nudge(id: string, dx: number, dz: number): boolean {
    const piece = this.piece(id);
    const spec = this.specFor(id);
    if (!piece || !spec) return false;
    const [x, y, z] = piece.item.position;
    const moved = keepInside(
      spec,
      { ...piece.item, position: [x + dx, y, z + dz] },
      this.options.limits,
    );
    return this.tryChange(piece, spec, moved);
  }

  /** Advances falling pieces; returns the ones that moved this frame. */
  step(dtS: number): Piece[] {
    const moved: Piece[] = [];
    for (const [id, drop] of this.drops) {
      const piece = this.piece(id);
      if (!piece) {
        this.drops.delete(id);
        continue;
      }
      const body = stepDrop(drop.body, dtS, drop.restY);
      drop.body = body;
      const [x, , z] = piece.item.position;
      moved.push(this.replace({ id, item: { ...piece.item, position: [x, body.y, z] } }));
      if (body.settled) this.drops.delete(id);
    }
    return moved;
  }

  /** Snaps every falling piece to rest; used when the player prefers reduced motion. */
  settleNow(): Piece[] {
    const moved: Piece[] = [];
    for (const [id, drop] of this.drops) {
      const piece = this.piece(id);
      if (piece) {
        const [x, , z] = piece.item.position;
        moved.push(this.replace({ id, item: { ...piece.item, position: [x, drop.restY, z] } }));
      }
    }
    this.drops.clear();
    return moved;
  }

  /** A new plant taller than the water is shrunk to fit; null when it would have to shrink too far. */
  private fitToWater(spec: DecorSpec, spot: DecorItem): DecorItem | null {
    const { waterTop } = this.options.limits;
    if (spec.kind !== 'plant' || waterTop === undefined) return spot;
    const rest = restHeight(spec, spot, this.options.ground);
    const available = waterTop - SURFACE_MARGIN - rest;
    const height = spec.box.max[1] * spot.scale;
    if (available >= height) return spot;
    const scale = Math.floor((spot.scale * available * 1000) / height) / 1000;
    return scale < MIN_PLANT_SCALE ? null : { ...spot, scale };
  }

  /** How far above rest a new piece starts falling; a plant gets only the headroom the water leaves it. */
  private dropHeightFor(spec: DecorSpec, item: DecorItem, rest: number): number {
    const { waterTop } = this.options.limits;
    if (spec.kind !== 'plant' || waterTop === undefined) return NEW_PIECE_DROP_HEIGHT;
    const room = waterTop - SURFACE_MARGIN - (rest + spec.box.max[1] * item.scale);
    return Math.max(0, Math.min(NEW_PIECE_DROP_HEIGHT, room));
  }

  private tryChange(piece: Piece, spec: DecorSpec, candidate: DecorItem): boolean {
    const rest = restHeight(spec, candidate, this.options.ground);
    const item = tidy({
      ...candidate,
      position: [candidate.position[0], rest, candidate.position[2]],
    });
    const reason = check(spec, item, this.obstaclesExcept(piece.id), this.options.limits);
    if (reason) {
      this.problem = describeRejection(reason);
      return false;
    }
    this.problem = null;
    this.drops.delete(piece.id);
    this.replace({ id: piece.id, item });
    return true;
  }

  private settle(piece: Piece, spec: DecorSpec): void {
    const rest = restHeight(spec, piece.item, this.options.ground);
    const item = tidy(piece.item);
    this.replace({ id: piece.id, item });
    this.drops.set(piece.id, { body: startDrop(item.position[1]), restY: rest });
  }

  private replace(piece: Piece): Piece {
    this.list = this.list.map((p) => (p.id === piece.id ? piece : p));
    return piece;
  }

  private isDragged(id: string): boolean {
    return this.drag?.id === id;
  }

  private specFor(id: string): DecorSpec | undefined {
    const piece = this.piece(id);
    return piece ? this.options.specs.get(piece.item.assetId) : undefined;
  }

  private obstacles(): Obstacle[] {
    return this.obstaclesExcept(null);
  }

  private obstaclesExcept(id: string | null): Obstacle[] {
    const out: Obstacle[] = [];
    for (const p of this.list) {
      const spec = this.options.specs.get(p.item.assetId);
      if (spec && p.id !== id) out.push({ spec, item: p.item });
    }
    return out;
  }
}
