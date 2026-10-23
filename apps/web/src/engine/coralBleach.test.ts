import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Texture,
  Vector3,
  type Node,
} from 'three/webgpu';
import { float, materialColor, uniform, vec4 } from 'three/tsl';
import {
  BLEACHED_SKELETON_ALBEDO,
  bleachedAlbedo,
  coralBleachColor,
  setMaterialBleach,
} from './coralBleach';
import { buildShaders, evaluate } from './shaderFixtures';

const albedo = (scan: Color, bleach: number): number[] =>
  evaluate(bleachedAlbedo(uniform(new Vector3(...scan.toArray())), uniform(bleach)));

const DULL_SCAN = new Color(0.12, 0.1, 0.08);
const SATURATED_SCAN = new Color(0.9, 0.05, 0.6);
const SCANS = [DULL_SCAN, SATURATED_SCAN, new Color(1, 1, 1), new Color(0, 0, 0)];

describe('bleachedAlbedo', () => {
  it('leaves an unbleached coral bit for bit at its live colour', () => {
    for (const scan of SCANS) expect(albedo(scan, 0)).toEqual(scan.toArray());
  });

  it('turns any scan, dull or saturated, into the near-white skeleton when fully bleached', () => {
    expect(BLEACHED_SKELETON_ALBEDO).toBeGreaterThanOrEqual(0.8);
    expect(BLEACHED_SKELETON_ALBEDO).toBeLessThanOrEqual(0.9);
    for (const scan of SCANS) {
      for (const channel of albedo(scan, 1))
        expect(channel).toBeCloseTo(BLEACHED_SKELETON_ALBEDO, 6);
    }
  });

  it('lightens a dull scan well past what lerping its tint toward 1 could', () => {
    const half = albedo(DULL_SCAN, 0.5);
    expect(half[0]).toBeCloseTo((0.12 + BLEACHED_SKELETON_ALBEDO) / 2, 6);
    expect(Math.max(...half)).toBeGreaterThan(Math.max(...DULL_SCAN.toArray()) * 3);
  });

  it('desaturates a saturated scan halfway at bleach 0.5', () => {
    const spread = (c: number[]) => Math.max(...c) - Math.min(...c);
    const half = albedo(SATURATED_SCAN, 0.5);
    expect(half[1]).toBeCloseTo((0.05 + BLEACHED_SKELETON_ALBEDO) / 2, 6);
    expect(spread(half)).toBeCloseTo(spread(SATURATED_SCAN.toArray()) / 2, 6);
  });

  it('moves monotonically and never exceeds an albedo of 1', () => {
    for (const scan of SCANS) {
      let previous = albedo(scan, 0);
      for (const bleach of [0.25, 0.5, 0.75, 1]) {
        const next = albedo(scan, bleach);
        next.forEach((channel, i) => {
          expect(channel).toBeLessThanOrEqual(1);
          expect(channel).toBeGreaterThanOrEqual(0);
          const before = previous[i] ?? Number.NaN;
          const toward = Math.sign(BLEACHED_SKELETON_ALBEDO - before);
          expect(Math.sign(channel - before) * toward).toBeGreaterThanOrEqual(0);
        });
        previous = next;
      }
    }
  });
});

describe('setMaterialBleach', () => {
  it('stores the clamped amount the shared node reads', () => {
    const material = new MeshStandardNodeMaterial();
    setMaterialBleach(material, 0.4);
    expect(material.userData.bleach).toBe(0.4);
    setMaterialBleach(material, 3);
    expect(material.userData.bleach).toBe(1);
    setMaterialBleach(material, -1);
    expect(material.userData.bleach).toBe(0);
  });
});

describe('coralBleachColor', () => {
  const coral = (map: boolean) => {
    const source = new MeshStandardMaterial({ color: 0x886644 });
    if (map) source.map = new Texture();
    const material = new MeshStandardNodeMaterial();
    material.copy(source);
    setMaterialBleach(material, 0.3);
    material.colorNode = coralBleachColor;
    return new Mesh(new BoxGeometry(), material);
  };

  for (const backend of ['webgpu', 'webgl'] as const) {
    it(`builds on ${backend} with and without a scan map`, () => {
      for (const map of [true, false]) {
        const { fragment } = buildShaders(coral(map), backend);
        expect(fragment).toContain('0.85');
      }
    });
  }

  for (const backend of ['webgpu', 'webgl'] as const) {
    it(`gives corals at bleach 0 and 1 one ${backend} program`, () => {
      for (const map of [true, false]) {
        const at = (bleach: number) => {
          const mesh = coral(map);
          setMaterialBleach(mesh.material as MeshStandardNodeMaterial, bleach);
          return buildShaders(mesh, backend);
        };
        expect(at(1)).toEqual(at(0));
      }
    });

    it(`would build two ${backend} programs if the amount were baked in (the cost this avoids)`, () => {
      const baked = (bleach: number) => {
        const mesh = coral(true);
        const live = vec4(materialColor as unknown as Node<'vec4'>);
        (mesh.material as MeshStandardNodeMaterial).colorNode = vec4(
          bleachedAlbedo(live.rgb, float(bleach)),
          live.a,
        );
        return buildShaders(mesh, backend).fragment;
      };
      expect(baked(1)).not.toBe(baked(0));
    });
  }
});
