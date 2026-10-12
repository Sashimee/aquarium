import { describe, expect, it } from 'vitest';
import { rewriteAssetUrl } from './assets';

describe('rewriteAssetUrl', () => {
  it('keeps 1k textures at the 1024 tier', () => {
    expect(rewriteAssetUrl('/assets/rock/a_1k.ktx2', 1024)).toBe('/assets/rock/a_1k.ktx2');
  });

  it('swaps to 2k textures at the 2048 tier, keeping any query', () => {
    expect(rewriteAssetUrl('/assets/rock/a_1k.ktx2', 2048)).toBe('/assets/rock/a_2k.ktx2');
    expect(rewriteAssetUrl('/assets/rock/a_1k.ktx2?v=3', 2048)).toBe('/assets/rock/a_2k.ktx2?v=3');
  });

  it('leaves other urls alone', () => {
    expect(rewriteAssetUrl('/assets/rock/a.glb', 2048)).toBe('/assets/rock/a.glb');
  });

  it('redirects the basis transcoder to the bundled copy', () => {
    const js = rewriteAssetUrl('https://cdn/libs/basis/basis_transcoder.js', 1024);
    const wasm = rewriteAssetUrl('https://cdn/libs/basis/basis_transcoder.wasm', 1024);
    expect(js).not.toContain('cdn');
    expect(wasm).not.toContain('cdn');
    expect(js).not.toBe(wasm);
  });
});
