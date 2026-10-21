import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Tank } from '@aquarium/shared';
import { tankFixture } from '../sync/fixtures';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE, type SessionState } from '../sync/state';
import { ShareSection } from './ShareSection';

const session = {} as TankSession;
const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...INITIAL_STATE,
  ...overrides,
});

function render(tank: Tank, s = state()) {
  return renderToStaticMarkup(createElement(ShareSection, { session, state: s, tank }));
}

function checkbox(html: string): string {
  return /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
}

describe('Show in gallery toggle', () => {
  it('is off and disabled until the tank has a public link', () => {
    const html = render(tankFixture({ shared: false }));
    expect(html).toContain('Show in gallery');
    expect(checkbox(html)).toContain('disabled');
    expect(checkbox(html)).not.toContain('checked');
    expect(html).toContain('A link alone never lists your tank');
  });

  it('is enabled and still off for a shared tank, so the link alone does not list it', () => {
    const html = render(tankFixture({ shared: true, inGallery: false }));
    expect(checkbox(html)).not.toContain('disabled');
    expect(checkbox(html)).not.toContain('checked');
    expect(html).toContain('Turn this on to put your tank in the weekly gallery');
  });

  it('shows the listed state', () => {
    const html = render(tankFixture({ shared: true, inGallery: true }));
    expect(checkbox(html)).toContain('checked');
    expect(html).toContain('Your tank is in the tank of the week gallery');
  });

  it('is locked while a request runs and for a quarantine tank', () => {
    expect(checkbox(render(tankFixture({ shared: true }), state({ busy: true })))).toContain(
      'disabled',
    );
    const html = render(tankFixture({ shared: true, quarantine: true }));
    expect(checkbox(html)).toContain('disabled');
    expect(html).toContain('A quarantine tank cannot be listed');
  });
});
