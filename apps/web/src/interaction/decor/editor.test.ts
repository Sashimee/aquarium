import { legacyTintSeed, type Biome } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { loadPreset } from '../../scene/preset';
import { DecorEditor } from './editor';
import { flat, item, LIMITS, must, SPECS, spec } from './fixtures';
import { footprintOf, overlaps } from './footprint';
import { numberPieces, splitLayout, type Piece } from './layout';
import { check, MAX_PIECES, restHeight } from './rules';
import { VACATION_FEEDER_ASSET_ID } from './spec';

const piece = (id: string, assetId: string, x: number, z: number): Piece => ({
  id,
  item: item(assetId, x, z),
});

function editor(pieces: Piece[] = [], biome: Biome = 'reef'): DecorEditor {
  return new DecorEditor({ specs: SPECS, biome, limits: LIMITS, ground: flat, pieces });
}

function finishSettling(e: DecorEditor): void {
  for (let i = 0; i < 600 && e.busy; i++) e.step(1 / 60);
}

describe('dragging', () => {
  it('moves the grabbed piece under the pointer and drops it to rest', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    expect(e.grab('p1', { x: 0, z: 0 })).toBe(true);
    const lifted = e.dragTo(0.3, 0.1);
    expect(lifted?.item.position[0]).toBeCloseTo(0.3, 6);
    expect(lifted?.item.position[1]).toBeGreaterThan(
      restHeight(spec('boulder-01'), must(lifted).item, flat),
    );
    expect(e.drop()).toBe('moved');
    finishSettling(e);
    const rest = must(e.piece('p1'));
    expect(rest.item.position[1]).toBeCloseTo(restHeight(spec('boulder-01'), rest.item, flat), 3);
    expect(e.busy).toBe(false);
  });

  it('keeps the point that was grabbed under the pointer', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    e.grab('p1', { x: 0.05, z: 0.02 });
    const moved = e.dragTo(0.25, 0.02);
    expect(moved?.item.position[0]).toBeCloseTo(0.2, 6);
    expect(moved?.item.position[2]).toBeCloseTo(0, 6);
  });

  it('slides along the glass instead of leaving the tank', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    e.grab('p1', { x: 0, z: 0 });
    const moved = e.dragTo(5, 0);
    expect(moved?.item.position[0]).toBeCloseTo(LIMITS.halfLength - 0.12163, 3);
    expect(e.problem).toBeNull();
  });

  it('puts a piece dropped on another back where it came from', () => {
    const e = editor([piece('p1', 'boulder-01', -0.3, 0), piece('p2', 'boulder-01', 0.3, 0)]);
    e.grab('p1', { x: -0.3, z: 0 });
    e.dragTo(0.25, 0);
    expect(e.problem).toMatch(/overlap/i);
    expect(e.drop()).toBe('reverted');
    expect(e.piece('p1')?.item.position).toEqual([-0.3, 0.06, 0]);
    expect(e.busy).toBe(false);
  });

  it('treats a grab without movement as nothing', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    e.grab('p1', { x: 0, z: 0 });
    e.dragTo(0, 0);
    expect(e.drop()).toBe('unchanged');
    expect(e.piece('p1')?.item.position).toEqual([0, 0.06, 0]);
  });

  it('refuses to grab a piece that is not there', () => {
    expect(editor().grab('nope', { x: 0, z: 0 })).toBe(false);
  });
});

describe('picking', () => {
  it('returns the nearest piece along the ray', () => {
    const e = editor([piece('p1', 'boulder-01', -0.3, 0), piece('p2', 'boulder-01', 0.3, 0)]);
    const hit = e.pick({ origin: { x: 0.3, y: 1, z: 0 }, dir: { x: 0, y: -1, z: 0 } });
    expect(hit?.id).toBe('p2');
    expect(e.pick({ origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: -1, z: 0 } })).toBeNull();
  });
});

describe('adding and removing', () => {
  it('adds a piece in clear space and lets it fall in', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    const result = e.add('coast-rocks-05');
    expect('id' in result).toBe(true);
    expect(e.pieces).toHaveLength(2);
    const added = must(e.pieces[1]);
    const f = footprintOf(spec('coast-rocks-05'), added.item, 0.8);
    const other = footprintOf(spec('boulder-01'), must(e.pieces[0]).item, 0.8);
    expect(overlaps(f, other, 0.005)).toBe(false);
    expect(e.busy).toBe(true);
    finishSettling(e);
    expect(e.piece(added.id)?.item.position[1]).toBeCloseTo(
      restHeight(spec('coast-rocks-05'), added.item, flat),
      3,
    );
    expect(e.selectedId).toBe(added.id);
  });

  it('reports the resting height before the piece has landed', () => {
    const e = editor();
    e.add('boulder-01');
    const resting = must(e.restingPieces()[0]);
    expect(resting.item.position[1]).toBeCloseTo(
      restHeight(spec('boulder-01'), resting.item, flat),
      3,
    );
    expect(must(e.pieces[0]).item.position[1]).toBeGreaterThan(resting.item.position[1]);
  });

  it('refuses a second vacation feeder', () => {
    const e = editor();
    expect('id' in e.add(VACATION_FEEDER_ASSET_ID)).toBe(true);
    expect(e.hasFeeder).toBe(true);
    expect(e.add(VACATION_FEEDER_ASSET_ID)).toEqual({ rejection: 'feeder-exists' });
    expect(e.pieces).toHaveLength(1);
  });

  it('allows the feeder again after removing it', () => {
    const e = editor();
    const first = e.add(VACATION_FEEDER_ASSET_ID);
    e.remove((first as { id: string }).id);
    expect(e.hasFeeder).toBe(false);
    expect('id' in e.add(VACATION_FEEDER_ASSET_ID)).toBe(true);
  });

  it('stops at the piece limit', () => {
    const e = editor();
    let added = 0;
    for (let i = 0; i < MAX_PIECES + 5; i++) {
      if ('id' in e.add('lambis-shell')) added++;
    }
    expect(added).toBeLessThanOrEqual(MAX_PIECES);
    expect(e.pieces.length).toBe(added);
    for (let i = 0; i < e.pieces.length; i++) {
      for (let j = i + 1; j < e.pieces.length; j++) {
        const a = footprintOf(spec('lambis-shell'), must(e.pieces[i]).item, 0.8);
        const b = footprintOf(spec('lambis-shell'), must(e.pieces[j]).item, 0.8);
        expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it('rejects an unknown asset', () => {
    expect(editor().add('no-such-thing')).toEqual({ rejection: 'unknown-asset' });
  });

  it('removes a piece and clears the selection', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    e.select('p1');
    expect(e.remove('p1')).toBe(true);
    expect(e.pieces).toHaveLength(0);
    expect(e.selectedId).toBeNull();
    expect(e.remove('p1')).toBe(false);
  });

  it('does not reuse the id of a removed piece', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    const a = e.add('lambis-shell') as { id: string };
    e.remove(a.id);
    const b = e.add('lambis-shell') as { id: string };
    expect(b.id).not.toBe(a.id);
  });
});

describe('rotate and nudge', () => {
  it('rotates in place and keeps the angle in range', () => {
    const e = editor([piece('p1', 'lambis-shell', 0, 0)]);
    for (let i = 0; i < 30; i++) e.rotate('p1', Math.PI / 6);
    const turned = must(e.piece('p1')).item.rotationY;
    expect(Math.abs(turned)).toBeLessThanOrEqual(Math.PI);
  });

  it('refuses a turn that would push into a neighbour', () => {
    const wood = piece('p1', 'driftwood-branch', 0, 0);
    const e = editor([wood, piece('p2', 'lambis-shell', 0, 0.15)]);
    expect(e.rotate('p1', Math.PI / 2)).toBe(false);
    expect(e.problem).toMatch(/overlap/i);
    expect(e.piece('p1')?.item.rotationY).toBe(0);
  });

  it('nudges by a fixed step and refuses to step into a neighbour', () => {
    const e = editor([piece('p1', 'lambis-shell', 0, 0), piece('p2', 'lambis-shell', 0.2, 0)]);
    expect(e.nudge('p1', 0.02, 0)).toBe(true);
    expect(e.piece('p1')?.item.position[0]).toBeCloseTo(0.02, 6);
    expect(e.nudge('p1', 0.18, 0)).toBe(false);
  });

  it('keeps a nudged piece on the gravel', () => {
    const ridge = (x: number) => (x > 0.1 ? 0.12 : 0.06);
    const e = new DecorEditor({
      specs: SPECS,
      biome: 'reef',
      limits: LIMITS,
      ground: ridge,
      pieces: [piece('p1', 'lambis-shell', 0, 0)],
    });
    expect(e.nudge('p1', 0.2, 0)).toBe(true);
    expect(must(e.piece('p1')).item.position[1]).toBeGreaterThan(0.1);
  });
});

describe('adding by biome', () => {
  it('refuses a reef-only piece in a freshwater tank and accepts it in a reef tank', () => {
    expect(editor([], 'freshwater').add('reef-arch')).toEqual({ rejection: 'wrong-biome' });
    expect(editor([], 'reef').add('reef-arch')).toHaveProperty('id');
  });

  it('refuses a second vacation feeder', () => {
    const e = editor([]);
    expect(e.add(VACATION_FEEDER_ASSET_ID)).toHaveProperty('id');
    expect(e.add(VACATION_FEEDER_ASSET_ID)).toEqual({ rejection: 'feeder-exists' });
    expect(e.pieces.filter((p) => p.item.assetId === VACATION_FEEDER_ASSET_ID)).toHaveLength(1);
  });
});

describe('the shipped presets', () => {
  for (const biome of ['freshwater', 'reef'] as const) {
    const pieces = numberPieces(splitLayout(loadPreset(biome).decor, SPECS).pieces);

    it(`${biome}: moving a piled-up piece either clears its neighbours or puts it back`, () => {
      expect(pieces.length).toBeGreaterThan(0);
      const first = must(pieces[0]);
      const home = first.item.position;
      for (const [x, z] of [
        [0.45, 0.1],
        [-0.45, -0.1],
        [0, 0.05],
      ] as const) {
        const e = editor(pieces);
        e.grab(first.id, { x: home[0], z: home[2] });
        e.dragTo(x, z);
        const result = e.drop();
        const now = must(e.piece(first.id));
        if (result === 'reverted') {
          expect(now.item.position).toEqual(home);
        } else {
          expect(check(spec(now.item.assetId), now.item, others(e, first.id), LIMITS)).toBeNull();
        }
      }
    });
  }
});

function others(e: DecorEditor, exceptId: string) {
  return e.pieces
    .filter((p) => p.id !== exceptId)
    .map((p) => ({ spec: spec(p.item.assetId), item: p.item }));
}

describe('colour seed', () => {
  it('keeps the seed a piece started with through moves and turns', () => {
    const e = editor([piece('p1', 'boulder-01', 0, 0)]);
    const seed = must(e.piece('p1')).item.tintSeed;
    expect(seed).toBe(legacyTintSeed(item('boulder-01', 0, 0)));
    e.nudge('p1', 0.1, 0);
    e.rotate('p1', 0.5);
    expect(must(e.piece('p1')).item.tintSeed).toBe(seed);
  });

  it('gives a new piece a seed from where it was placed, and keeps a saved one', () => {
    const e = editor([{ id: 'p1', item: { ...item('boulder-01', 0, 0), tintSeed: 7 } }]);
    expect(must(e.piece('p1')).item.tintSeed).toBe(7);
    const added = e.add('boulder-01');
    if (!('id' in added)) throw new Error('expected a piece');
    const placed = must(e.piece(added.id)).item;
    expect(placed.tintSeed).toBe(legacyTintSeed(placed));
    e.nudge(added.id, 0.1, 0);
    expect(must(e.piece(added.id)).item.tintSeed).toBe(placed.tintSeed);
  });
});
