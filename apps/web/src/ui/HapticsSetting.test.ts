import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Haptics, type HapticsDeps } from '../interaction/haptics';
import { HapticsSetting } from './HapticsSetting';

function render(deps: Partial<HapticsDeps>, prepare: (h: Haptics) => void = () => undefined) {
  const haptics = new Haptics({
    vibrator: { vibrate: () => true },
    storage: null,
    now: () => 0,
    userHasActivated: () => true,
    ...deps,
  });
  prepare(haptics);
  return renderToStaticMarkup(createElement(HapticsSetting, { haptics }));
}

describe('HapticsSetting', () => {
  it('shows a checked, enabled switch where vibration works', () => {
    const html = render({});
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).not.toContain('disabled');
    expect(html).toContain('A short buzz when you tap the glass');
  });

  it('reflects a player who switched it off', () => {
    const html = render({}, (h) => h.setEnabled(false));
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).not.toContain('disabled');
  });

  it('disables the switch and says why where vibration is missing', () => {
    const html = render({ vibrator: null });
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain('does not support vibration');
  });

  it('explains the pause under reduced motion', () => {
    const html = render({}, (h) => h.setReducedMotion(true));
    expect(html).toContain('Paused because your device asks for reduced motion.');
  });
});
