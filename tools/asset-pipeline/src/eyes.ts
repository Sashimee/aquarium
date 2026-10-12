import { medianX } from './fins.ts';
import type { Part } from './parts.ts';

export interface EyePlacement {
  /** Distance of the eye centre behind the snout, as a fraction of the full body length including the tail. */
  fromSnout: number;
  /** Eye height within the body slab at that position, 0 = belly, 1 = back. */
  height: number;
  /** How far the eye centre sits inside the flank, as a fraction of its own radius; 0 puts the centre on the skin. */
  sink: number;
  /** Multiplies the eye size about its own centre. */
  scale?: number;
}

type Triple = [number, number, number];

function at(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}

function vertex(part: Part, i: number): Triple {
  return [at(part.positions, i * 3), at(part.positions, i * 3 + 1), at(part.positions, i * 3 + 2)];
}

function boundsOfVertices(
  parts: Part[],
  keep: (p: Triple) => boolean,
): { min: Triple; max: Triple } | null {
  const min: Triple = [Infinity, Infinity, Infinity];
  const max: Triple = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const part of parts)
    for (let i = 0; i < part.positions.length / 3; i++) {
      const p = vertex(part, i);
      if (!keep(p)) continue;
      found = true;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(at(min, a), at(p, a));
        max[a] = Math.max(at(max, a), at(p, a));
      }
    }
  return found ? { min, max } : null;
}

/**
 * Moves the two eyeballs of `eyes` (one part holding both, +Z forward, +Y up) onto the flanks of the head of `body`.
 * Some sources rig the eyes with their own bones, so the baked pose leaves them floating beside the snout.
 */
export function seatEyes(eyes: Part, body: Part[], placement: EyePlacement): void {
  const everything = boundsOfVertices(body, () => true);
  if (!everything) throw new Error('seatEyes: the body has no vertices');
  const midline = medianX(Float32Array.from(body.flatMap((p) => Array.from(p.positions))));
  const zSnout = everything.max[2];
  const bodyLength = zSnout - everything.min[2];
  const targetZ = zSnout - placement.fromSnout * bodyLength;

  const slab = 0.03 * bodyLength;
  const head = boundsOfVertices(body, (p) => Math.abs(p[2] - targetZ) <= slab);
  if (!head) throw new Error(`seatEyes: no body vertices within ${slab} of the eye position`);
  const targetY = head.min[1] + placement.height * (head.max[1] - head.min[1]);
  const flank = Math.max(Math.abs(head.max[0] - midline), Math.abs(head.min[0] - midline));
  const scale = placement.scale ?? 1;

  for (const side of [-1, 1]) {
    const members: number[] = [];
    for (let i = 0; i < eyes.positions.length / 3; i++)
      if (at(eyes.positions, i * 3) >= midline === side > 0) members.push(i);
    if (members.length === 0) throw new Error(`seatEyes: no eye vertices on side ${side}`);

    const centre: Triple = [0, 0, 0];
    for (const i of members) {
      const p = vertex(eyes, i);
      for (let a = 0; a < 3; a++) centre[a] = at(centre, a) + at(p, a) / members.length;
    }
    const radii = members
      .map((i) => {
        const p = vertex(eyes, i);
        return Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]);
      })
      .sort((a, b) => a - b);
    const radius = at(radii, Math.floor(radii.length / 2)) * scale;
    const target: Triple = [midline + side * (flank - placement.sink * radius), targetY, targetZ];
    for (const i of members) {
      const p = vertex(eyes, i);
      for (let a = 0; a < 3; a++)
        eyes.positions[i * 3 + a] = at(target, a) + (at(p, a) - at(centre, a)) * scale;
    }
  }
}
