// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const PHONE = '(max-width: 480px)';

let rules: Map<string, CSSStyleDeclaration>;

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(import.meta.dirname, 'game.css'), 'utf8');
  document.head.append(style);
  const media = Array.from(style.sheet?.cssRules ?? []).find(
    (r) => 'conditionText' in r && (r as CSSMediaRule).conditionText === PHONE,
  ) as CSSMediaRule | undefined;
  if (!media) throw new Error(`game.css has no ${PHONE} block`);
  rules = new Map();
  for (const r of Array.from(media.cssRules)) {
    if ('style' in r) rules.set((r as CSSStyleRule).selectorText, (r as CSSStyleRule).style);
  }
});

const rule = (selector: string): CSSStyleDeclaration => {
  const found = rules.get(selector);
  if (!found) throw new Error(`no phone rule for ${selector}`);
  return found;
};

describe('phone HUD layout', () => {
  it('gives the five-biome switcher its own full-width row so it cannot squeeze the status card', () => {
    const tank = rule('.tank-type');
    expect(tank.getPropertyValue('grid-column')).toBe('1 / -1');
    expect(tank.getPropertyValue('overflow-x')).toBe('auto');
    expect(tank.getPropertyValue('max-width')).toBe('100%');
  });

  it('keeps the status card, camera controls and tank type on distinct grid rows', () => {
    const rows = [rule('#ui .status-card'), rule('.camera-controls'), rule('.tank-type')].map((r) =>
      Number(r.getPropertyValue('grid-row')),
    );
    expect(new Set(rows).size).toBe(3);
    expect(rule('.hud-buttons').getPropertyValue('grid-row')).toBe(
      rule('#ui .status-card').getPropertyValue('grid-row'),
    );
  });

  it('lets the camera controls span the row so Dive and Follow stay reachable', () => {
    expect(rule('.camera-controls').getPropertyValue('grid-column')).toBe('1 / -1');
  });
});
