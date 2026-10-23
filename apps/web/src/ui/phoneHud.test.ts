// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// happy-dom has no layout, so this only guards the structure; e2e/phone-hud.spec.ts measures the boxes.
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

describe('phone HUD layout rules', () => {
  it('uses a single column, so no control can take width from the status card', () => {
    expect(rule('.hud').getPropertyValue('grid-template-columns')).toBe('minmax(0, 1fr)');
  });

  it('puts the status card, buttons, chip, camera and tank type on five distinct rows', () => {
    const rows = [
      rule('#ui .status-card'),
      rule('.hud-buttons'),
      rule('#ui .chem-chip'),
      rule('.camera-controls'),
      rule('.tank-type'),
    ].map((r) => Number(r.getPropertyValue('grid-row')));
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  it('lets the buttons wrap and keeps a readable minimum card width', () => {
    expect(rule('.hud-buttons').getPropertyValue('flex-wrap')).toBe('wrap');
    expect(rule('#ui .status-card').getPropertyValue('min-width')).toBe('9rem');
  });

  it('scrolls the tank type switcher inside its own row, with room for focus rings', () => {
    const tank = rule('.tank-type');
    expect(tank.getPropertyValue('overflow-x')).toBe('auto');
    expect(tank.getPropertyValue('max-width')).toBe('100%');
    expect(tank.getPropertyValue('padding-block')).not.toBe('');
  });

  it('reserves room under the taller HUD', () => {
    expect(rule('.stage').getPropertyValue('padding-top')).toBe('14rem');
  });
});
