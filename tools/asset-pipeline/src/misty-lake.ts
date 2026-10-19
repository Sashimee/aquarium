import {
  createReadStream,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { RAW_ROOT } from './source.ts';

export const MISTY_LAKE_ID = 'bg-fw-misty-lake';
export const MISTY_LAKE_WIDTH = 4096;
export const MISTY_LAKE_HEIGHT = 2048;
export const MISTY_LAKE_RENDER = join(RAW_ROOT, MISTY_LAKE_ID, 'render.png');

const SIGMA_LEVELS = [0, 2, 4, 7, 11] as const;
const MAX_FAR_SIGMA = 11;
const MAX_NEAR_SIGMA = 4;

export interface DepthParams {
  near: number;
  far: number;
  focus: number;
}

/** Blur radius in pixels at a camera distance: far plants go soft quickly, the foreground only slightly. */
export function blurSigma(distance: number, focus: number): number {
  if (distance > focus) return Math.min(MAX_FAR_SIGMA, (distance - focus) * 4);
  return Math.min(MAX_NEAR_SIGMA, (focus - distance) * 1.5);
}

export function distanceFromDepthByte(byte: number, params: DepthParams): number {
  return params.near + (byte / 255) * (params.far - params.near);
}

/** Blends pre-blurred copies of the image per pixel; `levels[i]` is blurred with SIGMA_LEVELS[i]. */
export function applyDepthOfField(
  levels: readonly Uint8Array[],
  depthRed: Uint8Array,
  params: DepthParams,
  pixels: number,
  channels: number,
): Uint8Array {
  if (levels.length !== SIGMA_LEVELS.length) {
    throw new Error(`need ${SIGMA_LEVELS.length} blur levels, got ${levels.length}`);
  }
  const out = new Uint8Array(pixels * channels);
  for (let p = 0; p < pixels; p++) {
    const sigma = blurSigma(distanceFromDepthByte(depthRed[p] ?? 255, params), params.focus);
    let upper = SIGMA_LEVELS.findIndex((s) => s >= sigma);
    if (upper < 0) upper = SIGMA_LEVELS.length - 1;
    const lower = Math.max(0, upper - 1);
    const span = (SIGMA_LEVELS[upper] ?? 0) - (SIGMA_LEVELS[lower] ?? 0);
    const t = span === 0 ? 0 : (sigma - (SIGMA_LEVELS[lower] ?? 0)) / span;
    const a = levels[lower];
    const b = levels[upper];
    if (!a || !b) throw new Error('blur level missing');
    for (let c = 0; c < channels; c++) {
      const i = p * channels + c;
      out[i] = Math.round((a[i] ?? 0) * (1 - t) + (b[i] ?? 0) * t);
    }
  }
  return out;
}

const ABSORPTION = [0.34, 0.085, 0.06] as const;
const VEIL_DENSITY = 0.13;
const VEIL_TOP = [64, 148, 138] as const;
const VEIL_BOTTOM = [6, 34, 40] as const;
const RAY_COLOUR = [190, 245, 225] as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function godRayStrength(u: number, v: number): number {
  const slant = u + v * 0.35;
  const beams =
    0.5 +
    0.5 * Math.sin(slant * 17 + 0.7) * 0.5 +
    0.25 * Math.sin(slant * 41 + 2.1) +
    0.25 * Math.sin(slant * 7.3 + 4.0);
  const soft = Math.max(0, beams - 0.35);
  return soft * Math.pow(Math.max(0, 1 - v * 1.25), 1.6);
}

/**
 * Colour-dependent absorption (red dies first), a veil that thickens with distance and
 * brightens toward the surface, soft god rays, vignette and seeded film grain.
 */
export function gradeUnderwater(
  rgb: Uint8Array,
  depthRed: Uint8Array,
  params: DepthParams,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(rgb.length);
  const grain = mulberry32(617);
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const veil = VEIL_TOP.map(
      (top, c) => (VEIL_BOTTOM[c] ?? 0) + (top - (VEIL_BOTTOM[c] ?? 0)) * Math.pow(1 - v, 1.4),
    );
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const u = x / (width - 1);
      const distance = distanceFromDepthByte(depthRed[p] ?? 255, params);
      const veilAmount = 1 - Math.exp(-VEIL_DENSITY * Math.max(0, distance - 1.2));
      const rays = godRayStrength(u, v) * (0.25 + 0.75 * veilAmount) * 0.34;
      const edge = Math.hypot(u - 0.5, (v - 0.5) * 0.9) * 1.4;
      const vignette = 1 - 0.38 * edge * edge;
      const noise = (grain() + grain() - 1) * 5;
      for (let c = 0; c < 3; c++) {
        const transmit = Math.exp(-(ABSORPTION[c] ?? 0) * Math.max(0, distance - 1.2));
        const lit = (rgb[p * 3 + c] ?? 0) * transmit * (1 - veilAmount * 0.5);
        const hazed = lit * (1 - veilAmount) + (veil[c] ?? 0) * veilAmount;
        const value = (hazed + (RAY_COLOUR[c] ?? 0) * rays) * vignette + noise;
        out[p * 3 + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return out;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'application/octet-stream',
  '.json': 'application/json',
};

function serve(roots: Record<string, string>): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = normalize(decodeURIComponent(url.pathname));
    const prefix =
      Object.keys(roots).find((p) => p !== '' && (path === p || path.startsWith(`${p}/`))) ?? '';
    const root = roots[prefix];
    if (root === undefined) {
      res.writeHead(404).end();
      return;
    }
    const file = resolve(root, `.${path.slice(prefix.length)}`);
    if (
      (file !== root && !file.startsWith(root + sep)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

interface Passes extends DepthParams {
  beauty: string;
  depth: string;
}

async function decodePng(dataUrl: string): Promise<Buffer> {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('the render page did not return a PNG data URL');
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

export async function renderMistyLake(repoRoot: string): Promise<string> {
  const { chromium } = await import('@playwright/test');
  const publicAssets = realpathSync(join(repoRoot, 'apps', 'web', 'public', 'assets'));
  const pageDir = realpathSync(join(repoRoot, 'tools', 'asset-pipeline', 'render', 'misty-lake'));
  const three = realpathSync(join(repoRoot, 'apps', 'web', 'node_modules', 'three'));
  const server = await serve({
    '/assets': publicAssets,
    '/three': three,
    '': pageDir,
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  let passes: Passes;
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[render page] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.error(`[render page] ${e.message}`));
    await page.goto(`${origin}/scene.html`);
    await page.waitForFunction('window.sceneReady === true', undefined, { timeout: 300_000 });
    passes = (await page.evaluate('window.renderPasses()')) as Passes;
  } finally {
    await browser.close();
    server.close();
  }

  const beauty = await sharp(await decodePng(passes.beauty))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { info } = beauty;
  if (info.width !== MISTY_LAKE_WIDTH || info.height !== MISTY_LAKE_HEIGHT) {
    throw new Error(`render came out ${info.width}x${info.height}, expected 4096x2048`);
  }
  const depthRaw = await sharp(await decodePng(passes.depth))
    .removeAlpha()
    .raw()
    .toBuffer();
  const pixels = info.width * info.height;
  const depthRed = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) depthRed[p] = depthRaw[p * 3] ?? 255;

  const levels: Uint8Array[] = [];
  for (const sigma of SIGMA_LEVELS) {
    const image = sharp(beauty.data, {
      raw: { width: info.width, height: info.height, channels: 3 },
    });
    levels.push(new Uint8Array(await (sigma === 0 ? image : image.blur(sigma)).raw().toBuffer()));
  }
  const blurred = applyDepthOfField(levels, depthRed, passes, pixels, 3);

  const graded = gradeUnderwater(blurred, depthRed, passes, info.width, info.height);
  const png = await sharp(Buffer.from(graded), {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  mkdirSync(join(RAW_ROOT, MISTY_LAKE_ID), { recursive: true });
  writeFileSync(MISTY_LAKE_RENDER, png);
  return MISTY_LAKE_RENDER;
}
