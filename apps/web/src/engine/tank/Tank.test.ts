import { describe, expect, it } from 'vitest';
import {
  Box3,
  Color,
  Mesh,
  type MeshBasicNodeMaterial,
  type MeshStandardNodeMaterial,
  Texture,
  Vector3,
} from 'three/webgpu';
import { texture } from 'three/tsl';
import { BACKGROUND_TIERS } from '@aquarium/shared';
import { Caustics } from '../water/caustics';
import { InteriorLight } from '../water/interior';
import { WaterMedium } from '../water/medium';
import { tankSizeSchema } from '@aquarium/shared';
import {
  DEFAULT_TANK,
  STAND_HEIGHT,
  TANK_DIMENSIONS,
  type TankDimensions,
  waterBounds,
} from './dimensions';
import { buildShaders, type ShaderBackend } from '../shaderFixtures';
import { meanSubstrateHeight } from './substrate';
import { UNREFLECTED_LAYER } from './surfaceReflection';
import { posterSpan, Tank } from './Tank';

const POSTER_ASPECT = BACKGROUND_TIERS.high[0] / BACKGROUND_TIERS.high[1];

function lit(d: TankDimensions = DEFAULT_TANK): { tank: Tank; interior: InteriorLight } {
  const medium = new WaterMedium(waterBounds(d), { cdom440: 0.05, turbidity: 0.08 });
  const interior = new InteriorLight(
    medium,
    new Caustics(medium),
    new Texture(),
    new Color(0.13, 0.09, 0.055),
    meanSubstrateHeight(d),
  );
  return { tank: new Tank(d, medium, new Texture(), interior, texture(new Texture())), interior };
}

function tank(d: TankDimensions = DEFAULT_TANK): Tank {
  return lit(d).tank;
}

function boxOf(t: Tank, name: string): Box3 {
  const mesh = meshes(t).get(name);
  if (mesh === undefined) throw new Error(`no mesh named ${name}`);
  return new Box3().setFromObject(mesh);
}

function lookups(shader: string): string[] {
  return shader.match(/\btexture(?:Load|Lod|Sample\w*)?\s*\(/g) ?? [];
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

  it.each(['webgpu', 'webgl'] as const)(
    'builds the glass, the backdrop and both undersides for %s',
    (backend: ShaderBackend) => {
      const t = tank();
      const byName = meshes(t);
      const built = (name: string): string => {
        const mesh = byName.get(name);
        if (mesh === undefined) throw new Error(`no mesh named ${name}`);
        return buildShaders(mesh, backend).fragment;
      };
      for (const name of ['glass-faces', 'backdrop', 'water-surface-underside']) {
        expect(built(name).length, name).toBeGreaterThan(0);
      }
      const traced = built('water-surface-underside');
      t.setSurfaceReflection(0.5);
      const mirrored = built('water-surface-underside');
      expect(mirrored).not.toBe(traced);
      // Each of the five taps reads the pass's colour and its depth.
      expect(lookups(mirrored).length - lookups(traced).length).toBe(10);
    },
  );

  it.each(['webgpu', 'webgl'] as const)(
    'mirrors the tank contents in the glass with five explicit-level taps of the frame for %s',
    (backend: ShaderBackend) => {
      const t = tank();
      const glass = meshes(t).get('glass-faces');
      if (glass === undefined) throw new Error('no glass-faces mesh');
      const traced = buildShaders(glass, backend).fragment;
      t.setSurfaceReflection(0.5);
      const mirrored = buildShaders(glass, backend).fragment;
      expect(mirrored).not.toBe(traced);
      expect(lookups(mirrored).length - lookups(traced).length).toBe(5);
      // The taps sit in a branch, where WGSL allows only explicit-level sampling.
      const explicit = backend === 'webgpu' ? /\btextureSampleLevel\s*\(/g : /\btextureLod\s*\(/g;
      const added = (mirrored.match(explicit) ?? []).length - (traced.match(explicit) ?? []).length;
      expect(added).toBe(5);
    },
  );

  it('mirrors the room in the glass at the reflected room level, not the lighting one (#1549)', () => {
    const { tank: t, interior } = lit();
    const material = meshes(t).get('glass-faces')?.material as MeshStandardNodeMaterial;
    const reads = (uniform: object): boolean => {
      let found = false;
      material.envNode?.traverse((n) => {
        if (n === uniform) found = true;
      });
      return found;
    };
    expect(material.envNode).not.toBeNull();
    expect(reads(interior.reflectionLevel)).toBe(true);
    expect(reads(interior.roomLevel)).toBe(false);
  });

  it('swaps the glass to the mirrored contents with the surface reflection, and back', () => {
    const t = tank();
    const material = meshes(t).get('glass-faces')?.material as MeshStandardNodeMaterial;
    const traced = material.outputNode;

    t.setSurfaceReflection(0.5);
    const mirrored = material.outputNode;
    const version = material.version;
    expect(mirrored).not.toBe(traced);

    t.setSurfaceReflection(1);
    expect(material.outputNode).toBe(mirrored);
    expect(material.version).toBe(version);

    t.setSurfaceReflection(0);
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

  it.each(tankSizeSchema.options)('builds the %s tank to its own size', (size) => {
    const d = TANK_DIMENSIONS[size];
    const t = tank(d);
    const near = (a: Vector3, b: Vector3): number => a.distanceTo(b);

    const glass = boxOf(t, 'glass-faces');
    expect(near(glass.min, new Vector3(-d.length / 2, 0, -d.depth / 2))).toBeLessThan(1e-6);
    expect(near(glass.max, new Vector3(d.length / 2, d.height, d.depth / 2))).toBeLessThan(1e-6);
    expect(boxOf(t, 'glass-edges').equals(glass)).toBe(true);

    const water = waterBounds(d);
    expect(t.waterBounds.equals(water)).toBe(true);
    for (const name of ['water-volume-absorb', 'water-volume-scatter']) {
      const box = boxOf(t, name);
      expect(near(box.min, water.min), name).toBeLessThan(1e-6);
      expect(near(box.max, water.max), name).toBeLessThan(1e-6);
    }
    for (const name of ['water-surface', 'water-surface-underside']) {
      const box = boxOf(t, name);
      expect(box.min.y, name).toBeCloseTo(water.max.y, 6);
      expect(box.max.y, name).toBeCloseTo(water.max.y, 6);
      expect(box.min.x, name).toBeCloseTo(water.min.x, 6);
      expect(box.max.x, name).toBeCloseTo(water.max.x, 6);
      expect(box.min.z, name).toBeCloseTo(water.min.z, 6);
      expect(box.max.z, name).toBeCloseTo(water.max.z, 6);
    }

    const backdrop = boxOf(t, 'backdrop');
    expect(backdrop.max.z).toBeLessThan(-d.depth / 2);
    expect(backdrop.max.z).toBeGreaterThan(-d.depth / 2 - 0.01);
    expect(backdrop.min.x).toBeCloseTo(-d.length / 2, 6);
    expect(backdrop.max.x).toBeCloseTo(d.length / 2, 6);
    expect(backdrop.min.y).toBeCloseTo(0, 6);
    expect(backdrop.max.y).toBeCloseTo(d.height, 6);

    const sand = boxOf(t, 'substrate');
    const innerX = d.length / 2 - d.glass;
    const innerZ = d.depth / 2 - d.glass;
    expect(sand.min.x).toBeCloseTo(-innerX, 6);
    expect(sand.max.x).toBeCloseTo(innerX, 6);
    expect(sand.min.z).toBeCloseTo(-innerZ, 6);
    expect(sand.max.z).toBeCloseTo(innerZ, 6);
    expect(sand.max.y).toBeLessThan(water.max.y);

    const stand = boxOf(t, 'stand');
    expect(stand.max.y).toBeCloseTo(0, 6);
    expect(stand.min.y).toBeCloseTo(-STAND_HEIGHT, 6);
    expect(stand.max.x).toBeGreaterThan(d.length / 2);
    expect(stand.max.z).toBeGreaterThan(d.depth / 2);
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

  it.each(tankSizeSchema.options)('crops the poster to cover the %s back pane', (size) => {
    const d = TANK_DIMENSIONS[size];
    const [u, v] = posterSpan(d);
    expect(Math.max(u, v)).toBe(1);
    expect(Math.min(u, v)).toBeGreaterThan(0);
    expect((u * POSTER_ASPECT) / v).toBeCloseTo(d.length / d.height, 9);
  });

  it('refits the poster to the back pane on a resize without touching its material', () => {
    const t = tank();
    const material = meshes(t).get('backdrop')?.material as MeshBasicNodeMaterial;
    const colorNode = material.colorNode;
    const version = material.version;
    const { pane, span } = t.poster;
    expect(pane.value.toArray()).toEqual([DEFAULT_TANK.length, DEFAULT_TANK.height]);
    expect(span.value.toArray()).toEqual(posterSpan(DEFAULT_TANK));

    const nano = TANK_DIMENSIONS.nano30;
    expect(posterSpan(nano)).not.toEqual(posterSpan(DEFAULT_TANK));
    t.resize(nano);
    expect(t.poster.pane).toBe(pane);
    expect(pane.value.toArray()).toEqual([nano.length, nano.height]);
    expect(span.value.toArray()).toEqual(posterSpan(nano));
    expect(material.colorNode).toBe(colorNode);
    expect(material.version).toBe(version);
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
