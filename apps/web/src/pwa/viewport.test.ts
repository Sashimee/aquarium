// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('page zoom lock', () => {
  it('disables page scaling in the viewport meta', () => {
    const html = read('../../index.html');
    const content = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';
    const parts = content.split(',').map((p) => p.trim());
    expect(parts).toContain('width=device-width');
    expect(parts).toContain('maximum-scale=1');
    expect(parts).toContain('user-scalable=no');
  });
});

const SHEETS = ['styles.css', 'game.css', 'photo.css'] as const;

function loadSheets(): CSSStyleSheet[] {
  document.head.replaceChildren();
  return SHEETS.map((name) => {
    const style = document.createElement('style');
    style.textContent = read(`../ui/${name}`);
    document.head.append(style);
    return style.sheet as CSSStyleSheet;
  });
}

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  for (const rule of Array.from(rules)) {
    if ('style' in rule) out.push(rule as CSSStyleRule);
    else if ('cssRules' in rule) out.push(...styleRules((rule as CSSGroupingRule).cssRules));
  }
  return out;
}

describe('overlay touch-action', () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it.each(SHEETS)('%s: every pointer-events: auto rule disallows pinch zoom', (name) => {
    const sheet = loadSheets()[SHEETS.indexOf(name)];
    if (!sheet) throw new Error(`${name} did not parse into a stylesheet`);
    const interactive = styleRules(sheet.cssRules).filter(
      (r) => r.style.getPropertyValue('pointer-events') === 'auto',
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const rule of interactive) {
      expect(['none', 'pan-x pan-y'], rule.selectorText).toContain(
        rule.style.getPropertyValue('touch-action'),
      );
    }
  });

  it('keeps sheet drag and photo-pad hold on touch-action: none', () => {
    loadSheets();
    const ui = document.createElement('div');
    ui.id = 'ui';
    ui.innerHTML = '<div class="sheet-grab"></div><button class="pad-button"></button>';
    document.body.append(ui);
    for (const selector of ['.sheet-grab', '.pad-button']) {
      const el = ui.querySelector(selector);
      if (!el) throw new Error(`${selector} missing from fixture`);
      expect(getComputedStyle(el).getPropertyValue('touch-action'), selector).toBe('none');
    }
  });
});
