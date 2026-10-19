import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { speciesFixture } from '../sync/fixtures';
import { describeAway, speciesNameMap } from '../sync/life';
import { AwayBody } from './LifeDialogs';

const away = { elapsedMinutes: 600, capped: false, deaths: [] };
const report = describeAway(away, speciesNameMap([speciesFixture()]));

function render(canReplay: boolean, needsNet = false) {
  return renderToStaticMarkup(
    createElement(AwayBody, {
      tankName: 'Home tank',
      report,
      canReplay,
      needsNet,
      onWatch: vi.fn(),
      onNet: vi.fn(),
      onContinue: vi.fn(),
    }),
  );
}

describe('AwayBody', () => {
  it('offers "Watch what happened" next to Continue when the away window is known', () => {
    const html = render(true);
    expect(html).toContain('Watch what happened');
    expect(html).toContain('Continue');
    expect(html).toContain('You were away for 10 hours.');
  });

  it('leaves the replay out when the server sent no away start', () => {
    const html = render(false);
    expect(html).not.toContain('Watch what happened');
    expect(html).toContain('Continue');
  });

  it('keeps the net shortcut when a fish is dead', () => {
    expect(render(true, true)).toContain('See the fish to net');
    expect(render(true)).not.toContain('See the fish to net');
  });
});
