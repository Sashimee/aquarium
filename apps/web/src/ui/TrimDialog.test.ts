import type { Plant } from '@aquarium/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { trimRange } from '../sync/plantTrim';
import { TrimBody } from './TrimDialog';

const plant: Plant = {
  key: 's7',
  assetId: 'plant-java-fern',
  tintSeed: 7,
  parentKey: null,
  position: null,
  size: 1.6,
  minSize: 0.4,
  maxSize: 2.4,
};

function render(refusal: string | null = null, busy = false): string {
  const range = trimRange(plant);
  if (!range) throw new Error('fixture plant must be trimmable');
  return renderToStaticMarkup(
    createElement(TrimBody, {
      plant,
      range,
      busy,
      refusal,
      onTrim: vi.fn(),
      onCancel: vi.fn(),
    }),
  ).replace(/<!-- -->/g, '');
}

describe('TrimBody', () => {
  it('shows the size against the limits and starts at a middle size on a labelled slider', () => {
    const html = render();
    expect(html).toContain('160% of its bought size (smallest 40%, largest 240%)');
    expect(html).toContain('for="trim-size"');
    expect(html).toContain('Cut it back to 100%');
    expect(html).toMatch(/min="0.4"/);
    expect(html).toMatch(/max="1.59"/);
    expect(html).toMatch(/value="1"/);
    expect(html).toContain('Trim to 100%');
  });

  it('announces a refusal and disables the button while busy', () => {
    expect(render()).not.toContain('role="alert"');
    const html = render('The java fern has not grown past that size.', true);
    expect(html).toContain('role="alert"');
    expect(html).toContain('has not grown past that size');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Trim to 100%/);
  });
});
