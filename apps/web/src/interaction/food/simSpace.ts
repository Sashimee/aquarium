/**
 * The sim works in tank space, the scene's own frame (#85), so food and stimuli cross unchanged.
 * Kept as the one place the two frames meet.
 */
export function sceneToSim(x: number, y: number, z: number, out: Float64Array): void {
  out[0] = x;
  out[1] = y;
  out[2] = z;
}
