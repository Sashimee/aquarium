import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PUBLIC = new URL('../../public/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, PUBLIC), 'utf8');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: Icon[];
}

const manifest = JSON.parse(read('manifest.webmanifest')) as Manifest;

function pngSize(src: string): { width: number; height: number } {
  const bytes = readFileSync(new URL(src.replace(/^\//, ''), PUBLIC));
  expect(bytes.subarray(1, 4).toString('ascii'), src).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Chromium's installability criteria: https://web.dev/articles/install-criteria
describe('web app manifest installability', () => {
  it('has a name, an in-scope start_url and an installable display mode', () => {
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
    expect(manifest.display).toBe('standalone');
  });

  it('has theme and background colours as hex values', () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('declares 192 and 512 PNG icons plus a maskable one', () => {
    const sizes = new Set(manifest.icons.map((icon) => icon.sizes));
    expect(sizes.has('192x192')).toBe(true);
    expect(sizes.has('512x512')).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  it.each(manifest.icons.map((icon) => [icon.src, icon] as const))(
    'icon %s exists with the declared size',
    (src, icon) => {
      expect(icon.type).toBe('image/png');
      expect(existsSync(new URL(src.replace(/^\//, ''), PUBLIC))).toBe(true);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(src)).toEqual({ width: w, height: h });
    },
  );

  it('ships the 180x180 Apple touch icon and links everything from index.html', () => {
    expect(pngSize('/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
  });

  it('ships a service worker with a fetch handler and the offline page it falls back to', () => {
    expect(read('sw.js')).toContain("addEventListener('fetch'");
    expect(read('sw.js')).toContain('/offline.html');
    expect(read('offline.html')).toContain('The tank is asleep');
  });
});
