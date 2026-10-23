import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('sets touch-action on every pointer-events: auto overlay rule', () => {
    const css = read('../ui/styles.css');
    const rules = css.split('}').filter((r) => /pointer-events:\s*auto/.test(r));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toMatch(/touch-action:\s*manipulation/);
  });
});
