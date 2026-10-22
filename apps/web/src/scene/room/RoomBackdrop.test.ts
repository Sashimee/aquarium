import { describe, expect, it } from 'vitest';
import {
  InstancedMesh,
  Raycaster,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
} from 'three/webgpu';
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

  it('gives every instanced mesh its own geometry', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'office', tank, tier: 'ultra' });
    const instanced = meshes(backdrop).filter((m) => m instanceof InstancedMesh);
    expect(instanced.length).toBeGreaterThan(1);
    expect(new Set(instanced.map((m) => m.geometry)).size).toBe(instanced.length);
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
    const instanced = meshes(backdrop).filter((m) => m instanceof InstancedMesh);
    const freed: unknown[] = [];
    const watch = (r: BufferGeometry | Material | InstancedMesh) =>
      (r as { addEventListener(t: 'dispose', l: () => void): void }).addEventListener(
        'dispose',
        () => freed.push(r),
      );
    for (const r of [...geometries, ...materials, ...instanced]) watch(r);
    backdrop.update({ choice: 'none', tank, tier: 'high' });
    expect(freed).toHaveLength(geometries.size + materials.size + instanced.length);
    backdrop.dispose();
    expect(backdrop.group.children).toHaveLength(0);
  });

  it('cuts the window opening in the back wall', () => {
    const backdrop = new RoomBackdrop();
    backdrop.update({ choice: 'living-room', tank, tier: 'low' });
    const slot = backdrop.layout?.window;
    if (!slot) throw new Error('no layout');
    const wall = meshes(backdrop).find((m) => m.name === 'room-wall-back');
    if (!wall) throw new Error('no back wall');
    wall.updateMatrixWorld(true);
    const cast = (x: number, y: number) =>
      new Raycaster(new Vector3(x, y, 5), new Vector3(0, 0, -1)).intersectObject(wall);
    expect(cast(slot.centre[0], slot.centre[1])).toHaveLength(0);
    const beside = slot.centre[0] + slot.size[0] / 2 + 0.2;
    expect(cast(beside, slot.centre[1])).toHaveLength(1);
  });
});
