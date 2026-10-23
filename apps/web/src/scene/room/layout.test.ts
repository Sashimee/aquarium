import { describe, expect, it } from 'vitest';
import { TANK_SIZES } from '@aquarium/shared';
import { defaultView, TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import {
  boxBounds,
  planRoom,
  ROOM_PRESETS,
  roomDetailFor,
  visibleParts,
  type Bounds,
  type RoomBox,
} from './layout';

const EPS = 1e-9;
const sizes = Object.keys(TANK_SIZES) as (keyof typeof TANK_SIZES)[];

function overlaps(a: Bounds, b: Bounds): boolean {
  return ([0, 1, 2] as const).every((i) => a.min[i] < b.max[i] - EPS && b.min[i] < a.max[i] - EPS);
}

function inside(inner: Bounds, outer: Bounds): boolean {
  return ([0, 1, 2] as const).every(
    (i) => inner.min[i] >= outer.min[i] - EPS && inner.max[i] <= outer.max[i] + EPS,
  );
}

const solid = (boxes: readonly RoomBox[]) => boxes.filter((b) => !b.flat);

describe.each(ROOM_PRESETS)('planRoom %s', (preset) => {
  describe.each(sizes)('on %s', (size) => {
    const tank = TANK_DIMENSIONS[size];
    const layout = planRoom(preset, tank, 7);

    it('keeps every piece inside the room', () => {
      for (const box of layout.boxes) {
        expect(inside(boxBounds(box), layout.shell), box.id).toBe(true);
      }
      for (const book of layout.books) expect(inside(boxBounds(book), layout.shell)).toBe(true);
    });

    it('never touches the tank or its stand', () => {
      for (const box of solid(layout.boxes)) {
        const bounds = boxBounds(box);
        expect(overlaps(bounds, layout.tank), `${box.id} / tank`).toBe(false);
        expect(overlaps(bounds, layout.stand), `${box.id} / stand`).toBe(false);
      }
    });

    it('keeps the back wall clear of the glass', () => {
      expect(layout.shell.min[2]).toBeLessThan(layout.tank.min[2]);
      expect(layout.tank.min[2] - layout.shell.min[2]).toBeGreaterThanOrEqual(0.1);
    });

    it('does not make solid pieces overlap each other', () => {
      const boxes = solid(layout.boxes);
      boxes.forEach((a, i) => {
        for (const b of boxes.slice(i + 1)) {
          expect(overlaps(boxBounds(a), boxBounds(b)), `${a.id} / ${b.id}`).toBe(false);
        }
      });
    });

    it('sets the window beside the tank, on the wall, clear of furniture', () => {
      const {
        centre,
        size: [w, h],
      } = layout.window;
      expect(centre[0] - w / 2).toBeGreaterThan(layout.tank.max[0]);
      expect(centre[0] + w / 2).toBeLessThan(layout.shell.max[0]);
      expect(centre[1] - h / 2).toBeGreaterThan(layout.shell.min[1]);
      expect(centre[1] + h / 2).toBeLessThan(layout.shell.max[1]);
      expect(centre[2]).toBe(layout.shell.min[2]);
      const opening: Bounds = {
        min: [centre[0] - w / 2, centre[1] - h / 2, layout.shell.min[2] - 0.5],
        max: [centre[0] + w / 2, centre[1] + h / 2, layout.shell.min[2] + 0.5],
      };
      for (const box of layout.boxes.filter((b) => !b.id.startsWith('window-'))) {
        expect(overlaps(boxBounds(box), opening), box.id).toBe(false);
      }
      expect(layout.window.paneZ).toBeLessThan(layout.shell.min[2]);
    });

    it('seats the default camera inside the room', () => {
      const { eye } = defaultView(tank);
      expect(inside({ min: [eye.x, eye.y, eye.z], max: [eye.x, eye.y, eye.z] }, layout.shell)).toBe(
        true,
      );
    });

    it('puts the floor at the foot of the stand', () => {
      expect(layout.shell.min[1]).toBe(layout.stand.min[1]);
    });
  });

  it('is deterministic for a seed and varies the books with it', () => {
    const tank = TANK_DIMENSIONS.standard;
    expect(planRoom(preset, tank, 3)).toEqual(planRoom(preset, tank, 3));
    expect(planRoom(preset, tank, 3).books).not.toEqual(planRoom(preset, tank, 4).books);
    expect(planRoom(preset, tank, 3).boxes).toEqual(planRoom(preset, tank, 4).boxes);
  });
});

describe('planRoom edge cases', () => {
  it('rejects an unknown preset', () => {
    expect(() => planRoom('garage' as never, TANK_DIMENSIONS.standard)).toThrow(/Unknown room/);
  });

  it.each(['length', 'depth', 'height'] as const)('rejects a tank with no %s', (key) => {
    expect(() => planRoom('office', { ...TANK_DIMENSIONS.standard, [key]: 0 })).toThrow(key);
    expect(() => planRoom('office', { ...TANK_DIMENSIONS.standard, [key]: Number.NaN })).toThrow(
      key,
    );
  });

  it('fits a tank far longer than any size on offer', () => {
    const layout = planRoom('living-room', { length: 3, depth: 0.6, height: 0.6 });
    for (const box of solid(layout.boxes)) {
      expect(overlaps(boxBounds(box), layout.stand)).toBe(false);
      expect(inside(boxBounds(box), layout.shell)).toBe(true);
    }
  });

  it('gives each preset its own furniture', () => {
    const living = planRoom('living-room', TANK_DIMENSIONS.standard).boxes.map((b) => b.id);
    const work = planRoom('office', TANK_DIMENSIONS.standard).boxes.map((b) => b.id);
    expect(living).toContain('sofa-seat');
    expect(work).toContain('desk-top');
    expect(work).not.toContain('sofa-seat');
  });
});

describe('detail by tier', () => {
  const layout = planRoom('office', TANK_DIMENSIONS.standard);

  it('maps every tier and drops props on the low one', () => {
    expect(roomDetailFor('low')).toBe('shell');
    expect(roomDetailFor('medium')).toBe('reduced');
    expect(roomDetailFor('high')).toBe('full');
    expect(roomDetailFor('ultra')).toBe('full');
    expect(visibleParts(layout, 'shell')).toEqual({ boxes: [], books: [], ceiling: false });
  });

  it('adds books and the ceiling only on the full detail', () => {
    const reduced = visibleParts(layout, 'reduced');
    const full = visibleParts(layout, 'full');
    expect(reduced.boxes.length).toBeGreaterThan(0);
    expect(reduced.books).toHaveLength(0);
    expect(reduced.ceiling).toBe(false);
    expect(full.books.length).toBeGreaterThan(50);
    expect(full.ceiling).toBe(true);
  });
});
