export interface RgbeImage {
  width: number;
  height: number;
  /** Linear RGB floats, three per pixel, top row first. */
  pixels: Float32Array;
}

function readLine(bytes: Uint8Array, from: number): { line: string; next: number } {
  let end = from;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  if (end >= bytes.length) throw new Error('Radiance header is truncated');
  return { line: new TextDecoder().decode(bytes.subarray(from, end)), next: end + 1 };
}

export function decodeRgbe(bytes: Uint8Array): RgbeImage {
  let { line, next } = readLine(bytes, 0);
  if (!line.startsWith('#?')) throw new Error('not a Radiance .hdr file (missing #? signature)');
  for (;;) {
    ({ line, next } = readLine(bytes, next));
    if (line === '') break;
    if (line.startsWith('FORMAT=') && line !== 'FORMAT=32-bit_rle_rgbe') {
      throw new Error(`unsupported Radiance format ${line}; only 32-bit_rle_rgbe is handled`);
    }
  }
  ({ line, next } = readLine(bytes, next));
  const size = /^-Y (\d+) \+X (\d+)$/.exec(line);
  if (!size) throw new Error(`unsupported Radiance resolution line "${line}"; need "-Y h +X w"`);
  const height = Number(size[1]);
  const width = Number(size[2]);
  const pixels = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  let at = next;
  const take = (): number => {
    const value = bytes[at++];
    if (value === undefined) throw new Error('Radiance pixel data is truncated');
    return value;
  };

  for (let y = 0; y < height; y++) {
    const b0 = take();
    const b1 = take();
    const b2 = take();
    const b3 = take();
    if (width >= 8 && width < 32768 && b0 === 2 && b1 === 2 && (b2 & 0x80) === 0) {
      if (((b2 << 8) | b3) !== width) throw new Error('Radiance scanline width mismatch');
      for (let channel = 0; channel < 4; channel++) {
        let x = 0;
        while (x < width) {
          let count = take();
          if (count > 128) {
            count -= 128;
            const value = take();
            if (x + count > width) throw new Error('Radiance run overflows the scanline');
            for (let i = 0; i < count; i++) scan[(x++ << 2) | channel] = value;
          } else {
            if (count === 0 || x + count > width)
              throw new Error('Radiance literal run overflows the scanline');
            for (let i = 0; i < count; i++) scan[(x++ << 2) | channel] = take();
          }
        }
      }
    } else {
      scan[0] = b0;
      scan[1] = b1;
      scan[2] = b2;
      scan[3] = b3;
      for (let x = 1; x < width; x++) for (let c = 0; c < 4; c++) scan[(x << 2) | c] = take();
    }
    for (let x = 0; x < width; x++) {
      const e = scan[(x << 2) | 3]!;
      const scale = e === 0 ? 0 : 2 ** (e - 136);
      const out = (y * width + x) * 3;
      pixels[out] = scan[x << 2]! * scale;
      pixels[out + 1] = scan[(x << 2) | 1]! * scale;
      pixels[out + 2] = scan[(x << 2) | 2]! * scale;
    }
  }
  return { width, height, pixels };
}

function toRgbe(r: number, g: number, b: number): [number, number, number, number] {
  const max = Math.max(r, g, b);
  if (max < 1e-32) return [0, 0, 0, 0];
  const exponent = Math.floor(Math.log2(max)) + 1;
  const scale = 256 / 2 ** exponent;
  return [
    Math.min(255, Math.floor(r * scale)),
    Math.min(255, Math.floor(g * scale)),
    Math.min(255, Math.floor(b * scale)),
    exponent + 128,
  ];
}

function encodeChannel(values: Uint8Array, out: number[]): void {
  let x = 0;
  while (x < values.length) {
    let run = 1;
    while (x + run < values.length && run < 127 && values[x + run] === values[x]) run++;
    if (run >= 4) {
      out.push(128 + run, values[x]!);
      x += run;
      continue;
    }
    const start = x;
    let count = 0;
    while (x < values.length && count < 128) {
      let ahead = 1;
      while (x + ahead < values.length && ahead < 4 && values[x + ahead] === values[x]) ahead++;
      if (ahead >= 4) break;
      x++;
      count++;
    }
    out.push(count);
    for (let i = start; i < start + count; i++) out.push(values[i]!);
  }
}

export function encodeRgbe(image: RgbeImage): Uint8Array {
  const { width, height, pixels } = image;
  if (width < 8 || width >= 32768) throw new Error(`width ${width} is outside RLE range 8..32767`);
  const head = new TextEncoder().encode(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
  );
  const out: number[] = [];
  const channels = [0, 1, 2, 3].map(() => new Uint8Array(width));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const rgbe = toRgbe(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      for (let c = 0; c < 4; c++) channels[c]![x] = rgbe[c]!;
    }
    out.push(2, 2, width >> 8, width & 0xff);
    for (const channel of channels) encodeChannel(channel, out);
  }
  const bytes = new Uint8Array(head.length + out.length);
  bytes.set(head, 0);
  bytes.set(out, head.length);
  return bytes;
}

/** Halves both dimensions with a 2x2 box filter in linear light. */
export function halve(image: RgbeImage): RgbeImage {
  const width = image.width >> 1;
  const height = image.height >> 1;
  const pixels = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        const at = (yy: number, xx: number): number =>
          image.pixels[(yy * image.width + xx) * 3 + c]!;
        pixels[(y * width + x) * 3 + c] =
          (at(2 * y, 2 * x) +
            at(2 * y, 2 * x + 1) +
            at(2 * y + 1, 2 * x) +
            at(2 * y + 1, 2 * x + 1)) /
          4;
      }
  return { width, height, pixels };
}

export function flipVertical(image: RgbeImage): RgbeImage {
  const row = image.width * 3;
  const pixels = new Float32Array(image.pixels.length);
  for (let y = 0; y < image.height; y++)
    pixels.set(image.pixels.subarray(y * row, (y + 1) * row), (image.height - 1 - y) * row);
  return { width: image.width, height: image.height, pixels };
}

/** Basis Universal's HDR ceiling; brighter input makes it rescale the whole image (KTXmapRange), which three ignores. */
export const HDR_ENCODER_MAX = 65000;

/** Clamps every channel to `limit` and returns the clamped image with the number of pixels that changed. */
export function clampPixels(
  image: RgbeImage,
  limit: number,
): { image: RgbeImage; clamped: number } {
  const pixels = new Float32Array(image.pixels.length);
  let clamped = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const r = image.pixels[i]!;
    const g = image.pixels[i + 1]!;
    const b = image.pixels[i + 2]!;
    if (Math.max(r, g, b) > limit) clamped++;
    pixels[i] = Math.min(r, limit);
    pixels[i + 1] = Math.min(g, limit);
    pixels[i + 2] = Math.min(b, limit);
  }
  return { image: { width: image.width, height: image.height, pixels }, clamped };
}
