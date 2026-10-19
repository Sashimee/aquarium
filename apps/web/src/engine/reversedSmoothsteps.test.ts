import { describe, expect, it } from 'vitest';
import type { SpriteNodeMaterial } from 'three/webgpu';
import { float, int, smoothstep, uniform, vec2 } from 'three/tsl';
import { createBubbles } from './effects/bubbles';
import { createParticulates } from './effects/particulates';
import { constantValue, reversedSmoothsteps } from './reversedSmoothsteps';
import { DEFAULT_TANK, waterBounds } from './tank/dimensions';
import { Caustics } from './water/caustics';
import { WaterMedium } from './water/medium';

describe('constantValue', () => {
  it('reads numbers through the wrappers TSL builds around them', () => {
    expect(constantValue(float(0.2))).toBe(0.2);
    expect(constantValue(float(float(0.2)))).toBe(0.2);
    expect(constantValue(int(3))).toBe(3);
    expect(constantValue(float(0.2).negate())).toBe(-0.2);
    expect(constantValue(vec2(0.2, 0.7).y)).toBe(0.7);
    expect(constantValue(vec2(0.2, 0.7).g)).toBe(0.7);
  });

  it('treats anything that can change after the graph is built as unknown', () => {
    expect(constantValue(uniform(0.2))).toBeNull();
    expect(constantValue(float(0.2).toVar())).toBeNull();
    expect(constantValue(float(uniform(0.2)))).toBeNull();
    expect(constantValue(vec2(0.2, 0.7))).toBeNull();
    expect(constantValue(vec2(0.2, 0.7).xy)).toBeNull();
    expect(constantValue(float(0.2).add(0.1))).toBeNull();
    expect(constantValue(null)).toBeNull();
  });
});

describe('reversedSmoothsteps', () => {
  const x = uniform(0.5);

  it('catches high-to-low edges written as literals, float(), negated or swizzled constants', () => {
    expect(reversedSmoothsteps(smoothstep(0.2, 0, x))).toEqual(['smoothstep(0.2, 0, x)']);
    expect(reversedSmoothsteps(smoothstep(float(0.2), float(0), x))).toEqual([
      'smoothstep(0.2, 0, x)',
    ]);
    expect(reversedSmoothsteps(smoothstep(float(0), float(0.2).negate(), x))).toEqual([
      'smoothstep(0, -0.2, x)',
    ]);
    expect(reversedSmoothsteps(smoothstep(vec2(0.9, 0.1).x, vec2(0.9, 0.1).y, x))).toEqual([
      'smoothstep(0.9, 0.1, x)',
    ]);
    expect(reversedSmoothsteps(smoothstep(0.3, 0.3, x))).toEqual(['smoothstep(0.3, 0.3, x)']);
  });

  it('finds one buried in a larger graph', () => {
    const graph = x
      .mul(2)
      .add(smoothstep(1, 0.9, x).oneMinus())
      .mul(smoothstep(0, 1, x));
    expect(reversedSmoothsteps(graph)).toEqual(['smoothstep(1, 0.9, x)']);
  });

  it('accepts ordered edges and edges it cannot know before run time', () => {
    expect(reversedSmoothsteps(smoothstep(0, 0.2, x))).toEqual([]);
    expect(reversedSmoothsteps(smoothstep(float(0), float(0.2), x).oneMinus())).toEqual([]);
    expect(reversedSmoothsteps(smoothstep(uniform(0.9), 0.1, x))).toEqual([]);
    expect(reversedSmoothsteps(null)).toEqual([]);
  });
});

describe('sprite effects', () => {
  const bounds = waterBounds(DEFAULT_TANK);
  const medium = new WaterMedium(bounds, { cdom440: 0.05, turbidity: 0.08 });

  const graphs = (material: SpriteNodeMaterial) => [
    material.positionNode,
    material.scaleNode,
    material.colorNode,
    material.opacityNode,
  ];

  it.each([
    ['bubbles', () => createBubbles(medium).material],
    ['particulates', () => createParticulates(medium, new Caustics(medium)).material],
  ])('orders every constant smoothstep edge low to high in the %s', (_, make) => {
    const material = make();
    expect(material.colorNode).not.toBeNull();
    expect(graphs(material).flatMap(reversedSmoothsteps)).toEqual([]);
  });
});
