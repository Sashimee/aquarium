import { describe, expect, it } from 'vitest';
import assetIndex from '../../public/assets/index.json';
import { DEFAULT_HDRI_URL } from './environment';
import environmentSource from './environment.ts?raw';

const ORIGIN = 'https://devfish.bas.lu';

describe('room HDRI', () => {
  it('is fetched from the page origin, never a third party', () => {
    expect(new URL(DEFAULT_HDRI_URL, `${ORIGIN}/`).origin).toBe(ORIGIN);
    expect(DEFAULT_HDRI_URL).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\/\//i);
  });

  it('points at a file listed in assets/index.json', () => {
    const files = assetIndex.assets
      .filter((asset) => asset.kind === 'hdri')
      .flatMap((asset) => asset.files.map((f) => f.file));
    const relative = DEFAULT_HDRI_URL.slice(DEFAULT_HDRI_URL.indexOf('assets/') + 'assets/'.length);
    expect(files).toContain(relative);
  });

  it('keeps no third-party URL in the module source', () => {
    expect(environmentSource).not.toMatch(/https?:\/\//);
  });
});
