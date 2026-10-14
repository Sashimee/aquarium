import { describe, expect, it } from 'vitest';
import {
  Box3,
  Color,
  ConstNode,
  LinearMipmapLinearFilter,
  TextureNode,
  VarNode,
  Vector3,
  type Node,
  type Texture,
} from 'three/webgpu';
import { float, time, uniform, vec2 } from 'three/tsl';
import { Caustics, castingShare, causticContrast } from './caustics';
import { daylightAt, parseClock } from '../daylight';
import { BAKE } from './causticPattern';
import { WaterMedium } from './medium';

const DARK_SAND = 0.08;
const REEF_SAND = 0.68;

function caustics(): Caustics {
  const medium = new WaterMedium(new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.5, 0.2)), {
    cdom440: 0,
    turbidity: 0.1,
  });
  return new Caustics(medium);
}

describe('castingShare', () => {
  it('is exactly zero with the main channel off, whatever the moonlight', () => {
    expect(castingShare(0, 0.12)).toBe(0);
    expect(castingShare(0, 0)).toBe(0);
  });

  it('is one with only the main channel on', () => {
    expect(castingShare(3.9, 3.9)).toBe(1);
  });

  it('falls through dusk, as the moonlight takes over', () => {
    const dusk = [1, 0.5, 0.1, 0.01].map((day) => {
      const main = 3.9 * day;
      return castingShare(main, main + 0.12 * (1 - day));
    });
    expect([...dusk].sort((a, b) => b - a)).toEqual(dusk);
    expect(new Set(dusk).size).toBe(dusk.length);
    expect(dusk[3]).toBeLessThan(0.3);
  });
});

describe('causticContrast', () => {
  it('is zero when nothing casts caustics', () => {
    expect(causticContrast(0.6, 0, DARK_SAND)).toBe(0);
  });

  it('is the full strength in daylight on dark sand', () => {
    expect(causticContrast(0.6, 1, DARK_SAND)).toBeCloseTo(0.6, 10);
  });

  it('is lower on bright reef sand, so the net does not dominate the frame', () => {
    const reef = causticContrast(0.6, 1, REEF_SAND);
    expect(reef).toBeLessThan(0.5 * causticContrast(0.6, 1, DARK_SAND));
    expect(reef).toBeGreaterThan(0);
  });

  it('never exceeds the strength on very dark substrate', () => {
    expect(causticContrast(0.6, 1, 0)).toBeCloseTo(0.6, 10);
  });
});

describe('Caustics.setHood', () => {
  const darkSand = new Color(0.13, 0.09, 0.055);
  const reefSand = new Color(0.75, 0.7, 0.6);
  const hood = new Color(1, 0.97, 0.92);
  const moonlight = new Color(0.04, 0.14, 0.9);
  const at = (clock: string): number => daylightAt(parseClock(clock));

  it('switches the caustics and the shafts off at night, with only the moonlight lit', () => {
    const c = caustics();
    c.setHood(hood, 4, moonlight, at('23:00'), darkSand);
    expect(c.contrast.value).toBe(0);
    expect(c.shaftContrast.value).toBe(0);
    expect(c.lightRadiance.value.equals(moonlight)).toBe(true);
  });

  it('gives the full strength at noon on dark sand, to the surfaces and the shafts', () => {
    const c = caustics();
    c.setHood(hood, 4, moonlight, at('12:00'), darkSand);
    expect(c.contrast.value).toBeCloseTo(c.strength.value, 10);
    expect(c.shaftContrast.value).toBeCloseTo(c.strength.value, 10);
    expect(c.lightRadiance.value.equals(hood.clone().multiplyScalar(4))).toBe(true);
  });

  it('fades both through dusk, as the moonlight takes over', () => {
    const c = caustics();
    const dusk = ['20:10', '20:25', '20:40', '20:55'].map((clock) => {
      c.setHood(hood, 4, moonlight, at(clock), darkSand);
      return [c.contrast.value, c.shaftContrast.value] as const;
    });
    for (let k = 1; k < dusk.length; k++) {
      expect(dusk[k]?.[0]).toBeLessThan(dusk[k - 1]?.[0] ?? NaN);
      expect(dusk[k]?.[1]).toBeLessThan(dusk[k - 1]?.[1] ?? NaN);
    }
    expect(dusk[dusk.length - 1]?.[0]).toBeGreaterThan(0);
  });

  it('lowers the surface contrast on bright sand but not the shafts', () => {
    const c = caustics();
    c.setHood(hood, 4, moonlight, at('12:00'), reefSand);
    expect(c.contrast.value).toBeLessThan(0.5 * c.strength.value);
    expect(c.shaftContrast.value).toBeCloseTo(c.strength.value, 10);
  });

  it('follows changes to the strength from the dev panel', () => {
    const c = caustics();
    c.strength.value = 0.3;
    c.setHood(hood, 4, moonlight, at('12:00'), darkSand);
    expect(c.contrast.value).toBeCloseTo(0.3, 10);
    expect(c.shaftContrast.value).toBeCloseTo(0.3, 10);
  });

  it('copies out the casting light, which a caller cannot then change', () => {
    const c = caustics();
    const day = at('20:40');
    c.setHood(hood, 4, moonlight, day, darkSand);
    const expected = hood.clone().multiplyScalar(4 * day);
    const out = new Color();
    expect(c.getCasting(out)).toBe(out);
    expect(out.equals(expected)).toBe(true);
    out.setRGB(9, 9, 9);
    expect(c.getCasting(new Color()).equals(expected)).toBe(true);
    c.setHood(hood, 4, moonlight, at('23:00'), darkSand);
    expect(c.getCasting(out).toArray()).toEqual([0, 0, 0]);
  });
});

describe('the baked caustics', () => {
  const meanLevel = Math.log2(BAKE.size);

  /**
   * The samples of the baked net tile in `node`'s graph: `level N` at an explicit mip, `bias` at a
   * biased per-pixel one. The unsampled texture nodes the samples are cloned from are left out.
   */
  function netTileTaps(node: Node): string[] {
    const taps: string[] = [];
    node.traverse((n) => {
      if (!(n instanceof TextureNode) || n.value.width !== BAKE.size) return;
      let level = n.levelNode;
      while (level instanceof VarNode) level = level.node;
      if (level instanceof ConstNode) taps.push(`level ${String(level.value)}`);
      else if (n.biasNode) taps.push('bias');
    });
    return taps;
  }

  // The GPU's fp32 `sin` makes its baked tile differ from any CPU replica, so a constant gain
  // measured on the CPU would leave a device-dependent brightness offset.
  it('normalises the tile by the mean of what the GPU baked, its 1x1 mip', () => {
    const c = caustics();
    const pattern = c.bakedPattern(uniform(vec2(3, 4)), uniform(vec2(0, 0)), float(1), float(0.5));
    const taps = netTileTaps(pattern);
    expect(taps.filter((tap) => tap === 'bias')).toHaveLength(2);
    expect(taps).toContain(`level ${meanLevel}`);
  });

  it('normalises the tile the same way where the shafts sample it', () => {
    const taps = netTileTaps(caustics().bakedAt(uniform(vec2(0.2, 0.1)), 0.45));
    expect(taps).toContain('level 1');
    expect(taps).toContain(`level ${meanLevel}`);
  });

  // The shafts sample it 12 times per pixel; the drift depends on time alone.
  it('takes a drift read once outside the loop instead of rebuilding it per sample', () => {
    const c = caustics();
    const reads = (n: Node): number => {
      let count = 0;
      n.traverse((child) => {
        if (child === time) count++;
      });
      return count;
    };
    const p = uniform(vec2(0.2, 0.1));
    expect(reads(c.bakedAt(p, 0.45))).toBeGreaterThan(0);
    expect(reads(c.bakedAt(p, 0.45, c.bakedMean(), uniform(vec2(0.3, 0.6))))).toBe(0);
    expect(reads(c.bakedDrift())).toBeGreaterThan(0);
  });

  it('has a 1x1 mip to read the mean from', () => {
    expect(Number.isInteger(meanLevel)).toBe(true);
  });

  // Without generated mips the mean level does not exist, and the shafts and the low tier's floor
  // would divide by whatever the backend returns for it.
  it('generates the mips of the tile it reads the mean from', () => {
    const tiles: Texture[] = [];
    caustics()
      .bakedMean()
      .traverse((n) => {
        if (n instanceof TextureNode && n.value.width === BAKE.size) tiles.push(n.value);
      });
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.generateMipmaps).toBe(true);
      expect(tile.minFilter).toBe(LinearMipmapLinearFilter);
    }
  });
});
