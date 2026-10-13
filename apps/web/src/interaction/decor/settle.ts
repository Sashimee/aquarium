export interface DropBody {
  /** Height of the piece's underside reference, metres. */
  readonly y: number;
  /** Vertical speed, positive up. */
  readonly vy: number;
  readonly settled: boolean;
}

/** A stone released under water: it speeds up, drag caps it near 0.4 m/s, and it barely rebounds. */
const GRAVITY = 3.6;
const DRAG = 9;
const RESTITUTION = 0.18;
const REST_SPEED = 0.04;
const MAX_SUBSTEP_S = 1 / 120;

export function startDrop(fromY: number): DropBody {
  return { y: fromY, vy: 0, settled: false };
}

/** Advances a drop towards the substrate at `restY`; pure, so the same inputs give the same fall. */
export function stepDrop(body: DropBody, dtS: number, restY: number): DropBody {
  if (body.settled) return body;
  let { y, vy } = body;
  let remaining = Math.min(dtS, 0.25);
  while (remaining > 1e-9) {
    const dt = Math.min(remaining, MAX_SUBSTEP_S);
    remaining -= dt;
    vy += (-GRAVITY - DRAG * vy) * dt;
    y += vy * dt;
    if (y <= restY) {
      y = restY;
      if (Math.abs(vy) < REST_SPEED) return { y, vy: 0, settled: true };
      vy = -vy * RESTITUTION;
      if (vy < REST_SPEED) return { y, vy: 0, settled: true };
    }
  }
  return { y, vy, settled: false };
}
