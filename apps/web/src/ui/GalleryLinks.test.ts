import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { PageLink } from './Gallery';

describe('PageLink', () => {
  it('is a plain anchor, so entering or leaving a gallery tank is a full page load', () => {
    const element = PageLink({ to: '/gallery/abc', children: 'Reef' });
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe('a');
    expect(element.props).toEqual({ href: '/gallery/abc', children: 'Reef' });
    expect(renderToStaticMarkup(createElement(PageLink, { to: '/gallery', children: 'x' }))).toBe(
      '<a href="/gallery">x</a>',
    );
  });
});
