import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));
const SAMPLES = 3;

const TOP = [14, 63, 94];
const BOTTOM = [4, 18, 36];
const FISH = [255, 154, 74];
const FIN = [255, 196, 120];
const EYE = [10, 20, 32];

// `scale` shrinks the fish so maskable icons keep it inside the safe zone.
function shade(x, y, scale) {
  let color = TOP.map((c, i) => c + (BOTTOM[i] - c) * y);
  const fx = (x - 0.5) / scale;
  const fy = (y - 0.5) / scale;
  const body = ((fx + 0.04) / 0.3) ** 2 + (fy / 0.17) ** 2 <= 1;
  const tail = fx >= 0.2 && fx <= 0.38 && Math.abs(fy) <= (fx - 0.2) * 0.9 + 0.02;
  const dorsal = fy < -0.1 && fy > -0.25 && Math.abs(fx + 0.02) < 0.14 - (-0.1 - fy) * 0.55;
  const eye = (fx + 0.19) ** 2 + (fy + 0.03) ** 2 <= 0.028 ** 2;
  if (body) color = FISH;
  if (tail || dorsal) color = FIN;
  if (eye) color = EYE;
  return color;
}

function render(size, scale) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const [cr, cg, cb] = shade(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
            scale,
          );
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const n = SAMPLES * SAMPLES;
      const at = py * stride + 1 + px * 4;
      raw[at] = Math.round(r / n);
      raw[at + 1] = Math.round(g / n);
      raw[at + 2] = Math.round(b / n);
      raw[at + 3] = 255;
    }
  }
  return raw;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function png(size, scale) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size, scale), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  writeFileSync(`${OUT}icon-${size}.png`, png(size, 1));
}
for (const size of [192, 512]) {
  writeFileSync(`${OUT}maskable-${size}.png`, png(size, 0.7));
}
// iOS rounds the corners itself and paints transparent pixels black, so the icon is opaque.
writeFileSync(`${OUT}apple-touch-icon.png`, png(180, 0.85));
