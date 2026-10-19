import { describe, expect, it } from 'vitest';
import { Color, Mesh, type MeshBasicNodeMaterial, Texture } from 'three/webgpu';
import { texture } from 'three/tsl';
import { Caustics } from '../water/caustics';
import { InteriorLight } from '../water/interior';
import { WaterMedium } from '../water/medium';
import { DEFAULT_TANK, waterBounds } from './dimensions';
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
  return new Tank(DEFAULT_TANK, medium, new Texture(), interior, texture(new Texture()));
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
});
