import {
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Texture,
} from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { propFilesFrom, roomPropMaterial } from './gltfPropSource';

describe('roomPropMaterial', () => {
  it('moves a glTF material, maps and all, onto a node twin the room lights', () => {
    const map = new Texture();
    const normalMap = new Texture();
    const source = new MeshStandardMaterial({
      name: 'leather',
      color: 0x804020,
      roughness: 0.7,
      metalness: 0.1,
      map,
      normalMap,
      transparent: true,
      opacity: 0.5,
      side: DoubleSide,
    });
    const freed = vi.spyOn(source, 'dispose');
    const twin = roomPropMaterial(source);
    expect(twin).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(twin.name).toBe('room-prop-leather');
    expect(twin.color.getHex()).toBe(0x804020);
    expect(twin).toMatchObject({ roughness: 0.7, metalness: 0.1, opacity: 0.5, transparent: true });
    expect(twin.side).toBe(DoubleSide);
    expect(twin.map).toBe(map);
    expect(twin.normalMap).toBe(normalMap);
    expect(freed).toHaveBeenCalled();
  });

  it('names an unnamed material, and refuses one that is not PBR', () => {
    expect(roomPropMaterial(new MeshStandardMaterial()).name).toBe('room-prop-material');
    expect(() => roomPropMaterial(new MeshBasicMaterial({ name: 'flat' }))).toThrow(
      'expected a glTF PBR material',
    );
  });
});

describe('propFilesFrom', () => {
  const files = propFilesFrom([
    { id: 'chair', kind: 'room-furniture', lods: [{ file: 'chair/lod0.glb' }] },
    { id: 'fish', kind: 'fish', lods: [{ file: 'fish/lod0.glb' }] },
  ]);

  it('finds a prop GLB at a LOD', () => {
    expect(files('chair', 0)).toBe('chair/lod0.glb');
  });

  it('refuses an unknown prop, a non-furniture asset or a missing LOD', () => {
    expect(() => files('sofa', 0)).toThrow('Unknown room prop "sofa"');
    expect(() => files('fish', 0)).toThrow('Unknown room prop "fish"');
    expect(() => files('chair', 2)).toThrow('has no LOD 2');
  });
});
