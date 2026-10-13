/**
 * The sim puts y = 0 on the substrate top (#64), the scene puts it on the bottom glass over a
 * sloped sand surface. This is the one place the two are converted for food and stimuli.
 */
export function sceneToSim(
  groundHeight: (x: number, z: number) => number,
): (x: number, y: number, z: number, out: Float64Array) => void {
  return (x, y, z, out) => {
    out[0] = x;
    out[1] = Math.max(0, y - groundHeight(x, z));
    out[2] = z;
  };
}
