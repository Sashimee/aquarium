import type { FoodParticle } from './particles';

export interface ReachBridge {
  /** The species in the tank that eat nori. */
  noriGrazers?(): readonly string[];
  /** Rejects while the sim is not ready. */
  canGrazeAt?(species: string, position: readonly [number, number, number]): Promise<boolean>;
}

/** How far a refused clip climbs per try; the #302 slot behind the reef rock clears within a few. */
export const CLIP_STEP_M = 0.02;

export type ClipSpot = { readonly y: number } | null;

/**
 * Where `clip` can stay so that some nori grazer could turn at it: where it is, else higher up the
 * same pane in `CLIP_STEP_M` steps below `ceilingY`, else null. A sim that cannot answer allows the
 * clip as placed.
 */
export async function reachableSpot(
  clip: FoodParticle,
  bridge: ReachBridge,
  toSim: (x: number, y: number, z: number, out: Float64Array) => void,
  ceilingY: number,
  stillCurrent: () => boolean,
): Promise<ClipSpot> {
  const grazers = bridge.noriGrazers?.() ?? [];
  const query = bridge.canGrazeAt;
  if (grazers.length === 0 || query === undefined) return { y: clip.y };
  const out = new Float64Array(3);
  try {
    for (let y = clip.y; y <= ceilingY; y += CLIP_STEP_M) {
      toSim(clip.x, y, clip.z, out);
      const at = [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0] as const;
      const answers = await Promise.all(grazers.map((s) => query.call(bridge, s, at)));
      if (!stillCurrent()) return { y: clip.y };
      if (answers.some(Boolean)) return { y };
    }
  } catch {
    // The sim is not up or the world is being rebuilt; the clip stays as placed, as before the check.
    return { y: clip.y };
  }
  return null;
}
