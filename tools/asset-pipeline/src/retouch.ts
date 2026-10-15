import type { Rgb } from './fin-paint.ts';
import type { Rgba } from './textures.ts';

/** Centres are pixels of the full source image; `retouchPhoto` shifts them into crop space. */
export type Retouch =
  | { kind: 'wash'; centre: [number, number]; radius: number; colour: Rgb; strength: number }
  | { kind: 'eye'; centre: [number, number]; radius: number; iris: Rgb; rim: Rgb };

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function blend(image: Rgba, x: number, y: number, colour: Rgb, amount: number): void {
  if (amount <= 0 || x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const o = (y * image.width + x) * 4;
  for (let c = 0; c < 3; c++)
    image.data[o + c] = Math.round(
      (image.data[o + c] ?? 0) * (1 - amount) + (colour[c] ?? 0) * amount,
    );
}

function forEachInDisc(
  image: Rgba,
  centre: [number, number],
  radius: number,
  visit: (x: number, y: number, distance: number) => void,
): void {
  const [cx, cy] = centre;
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++)
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++)
      visit(x, y, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius);
}

/** Paints in place; `crop` is the rectangle of the source image that `image` holds. */
export function retouchPhoto(
  image: Rgba,
  crop: { left: number; top: number },
  operations: Retouch[],
): void {
  for (const op of operations) {
    const centre: [number, number] = [op.centre[0] - crop.left, op.centre[1] - crop.top];
    if (op.kind === 'wash') {
      forEachInDisc(image, centre, op.radius, (x, y, d) =>
        blend(image, x, y, op.colour, op.strength * (1 - smooth(0.4, 1, d))),
      );
      continue;
    }
    const pupil: Rgb = [8, 8, 12];
    forEachInDisc(image, centre, op.radius, (x, y, d) => {
      blend(image, x, y, op.rim, 1 - smooth(0.92, 1, d));
      blend(image, x, y, op.iris, 1 - smooth(0.74, 0.8, d));
      blend(image, x, y, pupil, 1 - smooth(0.4, 0.46, d));
      const glint = Math.hypot(
        (x + 0.5 - centre[0]) / op.radius + 0.3,
        (y + 0.5 - centre[1]) / op.radius + 0.3,
      );
      blend(image, x, y, [250, 250, 250], 1 - smooth(0.1, 0.16, glint));
    });
  }
}
