import { describe, expect, it } from 'vitest';
import { InstancedMesh, type BufferGeometry, type Material, type Mesh } from 'three/webgpu';
import { TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import { RoomBackdrop } from './RoomBackdrop';

const tank = TANK_DIMENSIONS.standard;
const meshes = (backdrop: RoomBackdrop) => backdrop.group.children as Mesh[];
const names = (backdrop: RoomBackdrop) => meshes(backdrop).map((m) => m.name);

describe('RoomBackdrop', () => {
  it('draws nothing for none', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'none', tank, tier: 'high' });
    expect(backdrop.group.children).toHaveLength(0);
    expect(backdrop.layout).toBeNull();
    expect(backdrop.pane).toBeNull();
  });

  it('builds only the shell and window on the low tier', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'living-room', tank, tier: 'low' });
    expect(names(backdrop).sort()).toEqual([
      'room-floor',
      'room-wall-back',
      'room-wall-left',
      'room-wall-right',
      'room-window-pane',
    ]);
    expect(backdrop.pane).not.toBeNull();
  });

  it('adds furniture on medium and books plus ceiling on high', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'office', tank, tier: 'medium' });
    expect(names(backdrop)).not.toContain('room-books');
    expect(names(backdrop)).not.toContain('room-ceiling');
    expect(backdrop.group.children.length).toBeGreaterThan(5);
    backdrop.update({ choice: 'office', tank, tier: 'high' });
    expect(names(backdrop)).toContain('room-books');
    expect(names(backdrop)).toContain('room-ceiling');
  });

  it('draws furniture as one instanced mesh per shape and material', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'office', tank, tier: 'ultra' });
    const layout = backdrop.layout;
    if (!layout) throw new Error('no layout');
    const instanced = meshes(backdrop).filter(
      (m): m is InstancedMesh => m instanceof InstancedMesh,
    );
    const furniture = instanced.filter((m) => m.name !== 'room-books');
    const keys = new Set(layout.boxes.map((b) => `${b.shape}:${b.material}`));
    expect(furniture).toHaveLength(keys.size);
    expect(furniture.reduce((sum, m) => sum + m.count, 0)).toBe(layout.boxes.length);
    const books = instanced.find((m) => m.name === 'room-books');
    expect(books?.count).toBe(layout.books.length);
    expect(meshes(backdrop).length).toBeLessThan(20);
  });

  it('does not rebuild for an unchanged config and rebuilds for a new size', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'office', tank, tier: 'high' });
    const first = backdrop.group.children[0];
    backdrop.update({ choice: 'office', tank: { ...tank }, tier: 'high' });
    expect(backdrop.group.children[0]).toBe(first);
    backdrop.update({ choice: 'office', tank: TANK_DIMENSIONS.nano30, tier: 'high' });
    expect(backdrop.group.children[0]).not.toBe(first);
    expect(backdrop.layout?.tank.max[0]).toBeCloseTo(TANK_DIMENSIONS.nano30.length / 2);
  });

  it('frees geometries and materials when the choice goes back to none and on dispose', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'living-room', tank, tier: 'high' });
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const mesh of meshes(backdrop)) {
      geometries.add(mesh.geometry);
      materials.add(mesh.material as Material);
    }
    const freed: unknown[] = [];
    for (const r of [...geometries, ...materials])
      r.addEventListener('dispose', () => freed.push(r));
    backdrop.update({ choice: 'none', tank, tier: 'high' });
    expect(freed).toHaveLength(geometries.size + materials.size);
    backdrop.dispose();
    expect(backdrop.group.children).toHaveLength(0);
  });

  it('cuts the window opening in the back wall', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'living-room', tank, tier: 'low' });
    const wall = meshes(backdrop).find((m) => m.name === 'room-wall-back');
    const full = 6 * 3;
    expect(wall?.geometry.index?.count).toBeGreaterThan(full);
  });
});
