import { describe, expect, it } from 'vitest';
import { Box3, Color, Mesh, type MeshBasicNodeMaterial, Texture, Vector3 } from 'three/webgpu';
import { Caustics } from '../water/caustics';
import { InteriorLight } from '../water/interior';
import { WaterMedium } from '../water/medium';
import { DEFAULT_TANK, TANK_DIMENSIONS, waterBounds } from './dimensions';
import { meanSubstrateHeight } from './substrate';
import { UNREFLECTED_LAYER } from './surfaceReflection';
import { Tank } from './Tank';

function tank(): Tank {
  const medium = new WaterMedium(waterBounds(DEFAULT_TANK), { cdom440: 0.05, turbidity: 0.08 });
  const interior = new InteriorLight(
    medium,
    new Caustics(medium),
    new Texture(),
    new Color(0.13, 0.09, 0.055),
    meanSubstrateHeight(DEFAULT_TANK),
  );
  return new Tank(DEFAULT_TANK, medium, new Texture(), interior);
}

function meshes(t: Tank): Map<string, Mesh> {
  const found = new Map<string, Mesh>();
  t.group.traverse((object) => {
    if (object instanceof Mesh) found.set(object.name, object);
  });
  return found;
}

describe('Tank', () => {
  /**
   * The mirrored camera sits above the surface: drawing the surface, its underside or the glass
   * faces (which trace the eye's refracted ray) from there is wrong, and on WebGPU the underside
   * would sample the very target being drawn.
   */
  it('keeps the surface, its underside and the glass faces out of the reflection only', () => {
    const t = tank();
    const unreflected = 1 << UNREFLECTED_LAYER;
    const byName = meshes(t);
    for (const name of ['water-surface', 'water-surface-underside', 'glass-faces']) {
      expect(byName.get(name)?.layers.mask, name).toBe(unreflected);
    }
    const others = [...byName.values()].filter(
      (m) => !['water-surface', 'water-surface-underside', 'glass-faces'].includes(m.name),
    );
    expect(others.map((m) => m.name)).toEqual(
      expect.arrayContaining(['substrate', 'glass-edges', 'backdrop', 'stand']),
    );
    for (const mesh of others) expect(mesh.layers.mask, mesh.name).toBe(1);
  });

  it('swaps the underside to the reflection when it turns on, and back when it turns off', () => {
    const t = tank();
    const material = meshes(t).get('water-surface-underside')?.material as MeshBasicNodeMaterial;
    const traced = material.outputNode;

    t.setSurfaceReflection(0.5);
    const mirrored = material.outputNode;
    const version = material.version;
    expect(t.surfaceReflection).toBe(true);
    expect(mirrored).not.toBe(traced);

    t.setSurfaceReflection(1);
    expect(material.outputNode).toBe(mirrored);
    expect(material.version).toBe(version);

    t.setSurfaceReflection(0);
    expect(t.surfaceReflection).toBe(false);
    expect(material.outputNode).not.toBe(mirrored);
    expect(material.version).toBeGreaterThan(version);
  });

  it('rebuilds the glass, water and stand for a new size and moves its water box in place', () => {
    const t = tank();
    const bounds = t.waterBounds;
    const before = meshes(t);
    const oldGlass = before.get('glass-faces')?.geometry;
    let disposed = false;
    oldGlass?.addEventListener('dispose', () => {
      disposed = true;
    });

    const nano = TANK_DIMENSIONS.nano30;
    expect(t.resize(nano)).toBe(true);
    expect(t.dimensions).toEqual(nano);
    expect(t.waterBounds).toBe(bounds);
    expect(bounds.equals(waterBounds(nano))).toBe(true);
    expect(disposed).toBe(true);

    const after = meshes(t);
    const glass = new Box3().setFromObject(after.get('glass-faces') as Mesh);
    expect(glass.max.x).toBeCloseTo(nano.length / 2, 6);
    expect(glass.max.z).toBeCloseTo(nano.depth / 2, 6);
    expect(glass.max.y).toBeCloseTo(nano.height, 6);
    for (const name of ['water-volume-absorb', 'water-volume-scatter']) {
      const water = new Box3().setFromObject(after.get(name) as Mesh);
      expect(water.min.distanceTo(bounds.min), name).toBeLessThan(1e-6);
      expect(water.max.distanceTo(bounds.max), name).toBeLessThan(1e-6);
    }
    const surface = new Box3().setFromObject(after.get('water-surface') as Mesh);
    expect(surface.max.y).toBeCloseTo(bounds.max.y, 6);
    expect(surface.getSize(new Vector3()).x).toBeCloseTo(bounds.max.x - bounds.min.x, 6);
    const stand = new Box3().setFromObject(after.get('stand') as Mesh);
    expect(stand.max.x).toBeCloseTo(nano.length / 2 + 0.02, 6);
  });

  it('keeps its meshes and materials across a resize', () => {
    const t = tank();
    const before = meshes(t);
    t.resize(TANK_DIMENSIONS.long300);
    const after = meshes(t);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, mesh] of after) {
      expect(mesh, name).toBe(before.get(name));
      expect(mesh.material, name).toBe(before.get(name)?.material);
    }
  });

  it('does nothing for the size it already has, and rejects a broken one', () => {
    const t = tank();
    const geometry = meshes(t).get('glass-faces')?.geometry;
    expect(t.resize({ ...DEFAULT_TANK })).toBe(false);
    expect(meshes(t).get('glass-faces')?.geometry).toBe(geometry);
    expect(() => t.resize({ ...DEFAULT_TANK, length: 0 })).toThrow(/length/);
    expect(t.dimensions).toEqual(DEFAULT_TANK);
  });
});
