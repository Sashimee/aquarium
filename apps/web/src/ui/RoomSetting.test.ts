import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoomPreference } from '../scene/room/preference';
import { RoomSetting } from './RoomSetting';

function render(stored?: string) {
  const preference = new RoomPreference({
    getItem: () => stored ?? null,
    setItem: () => undefined,
  });
  return renderToStaticMarkup(createElement(RoomSetting, { preference }));
}

function checked(html: string): string[] {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('checked'))
    .map((tag) => /value="([^"]+)"/.exec(tag)?.[1] ?? '');
}

describe('RoomSetting', () => {
  it('offers none, living room and office', () => {
    const html = render();
    expect(html).toContain('No room');
    expect(html).toContain('Living room');
    expect(html).toContain('Office');
  });

  it('selects none by default', () => {
    expect(checked(render())).toEqual(['none']);
  });

  it('shows a stored choice', () => {
    expect(checked(render('office'))).toEqual(['office']);
  });
});
