import {
  ConstNode,
  ConvertNode,
  MathNode,
  Node,
  SplitNode,
  VarNode,
  type Node as AnyNode,
} from 'three/webgpu';

const SCALARS = new Set(['float', 'int', 'uint']);
const AXES: Readonly<Record<string, string>> = {
  x: 'x',
  y: 'y',
  z: 'z',
  w: 'w',
  r: 'x',
  g: 'y',
  b: 'z',
  a: 'w',
};

function component(value: unknown, swizzle: string): number | null {
  if (typeof value === 'number') return AXES[swizzle] === 'x' ? value : null;
  const axis = AXES[swizzle];
  if (axis === undefined || typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[axis];
  return typeof found === 'number' ? found : null;
}

function unwrap(node: AnyNode): AnyNode | null {
  let inner = node;
  while (inner instanceof VarNode) {
    if (!(inner.intent || inner.readOnly) || !(inner.node instanceof Node)) return null;
    inner = inner.node;
  }
  return inner;
}

/**
 * The value of a scalar node that is fixed when the graph is built, or null when it can change at
 * run time. Follows the wrappers TSL puts around a constant: `float(0.2)` is a ConstNode under a
 * VarNode intent, `float(x)` of a node is a ConvertNode, `vec2(a, b).x` is a SplitNode.
 */
export function constantValue(node: AnyNode | null): number | null {
  if (node === null) return null;
  if (node instanceof ConstNode) return typeof node.value === 'number' ? node.value : null;
  if (node instanceof VarNode) {
    const inner = unwrap(node);
    return inner === null ? null : constantValue(inner);
  }
  if (node instanceof ConvertNode) {
    if (!SCALARS.has(node.convertTo)) return null;
    const value = constantValue(node.node);
    return value === null || node.convertTo === 'float' ? value : Math.trunc(value);
  }
  if (node instanceof SplitNode) {
    const inner = unwrap(node.node);
    return inner instanceof ConstNode ? component(inner.value, node.components) : null;
  }
  if (node instanceof MathNode && node.method === MathNode.NEGATE) {
    const value = constantValue(node.aNode);
    return value === null ? null : -value;
  }
  return null;
}

/**
 * Every `smoothstep` in the graph whose edges are constant with low >= high. GLSL ES 3.00 §8.3
 * and MSL leave that result undefined, so a driver may return anything; write
 * `smoothstep(high, low, x)` as `smoothstep(low, high, x).oneMinus()` instead.
 */
export function reversedSmoothsteps(graph: AnyNode | null): string[] {
  const found: string[] = [];
  graph?.traverse((node) => {
    if (!(node instanceof MathNode) || node.method !== MathNode.SMOOTHSTEP) return;
    const low = constantValue(node.aNode);
    const high = constantValue(node.bNode);
    if (low !== null && high !== null && low >= high) found.push(`smoothstep(${low}, ${high}, x)`);
  });
  return found;
}
