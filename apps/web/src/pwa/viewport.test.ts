// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import {
  STICKY_INTERACTION_EVENTS,
  type InteractionEvents,
  type PhotoView,
} from '../interaction/events';
import { createApiClient } from '../ui/api';
import { UiProviders } from '../ui/context';
import { PhotoLayer, PhotoTools } from '../ui/PhotoControls';
import { Sheet } from '../ui/Sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const SHEETS = ['styles.css', 'game.css', 'photo.css', 'loading.css'] as const;
const ALLOWED = ['none', 'pan-x pan-y'];

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

function splitTopLevel(selectorList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const ch = selectorList[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(selectorList.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(selectorList.slice(start).trim());
  return out;
}

function firstAlternative(part: string): string {
  return part.replace(
    /:(?:is|where)\(([^)]*)\)/g,
    (_, list: string) => splitTopLevel(list)[0] ?? '',
  );
}

function compound(part: string): HTMLElement {
  const bare = part.replace(/:not\([^)]*\)/g, '').replace(/:[a-z-]+(\([^)]*\))?/g, '');
  const el = document.createElement(/^[a-z][a-z0-9]*/i.exec(bare)?.[0] ?? 'div');
  const id = /#([\w-]+)/.exec(bare)?.[1];
  if (id) el.id = id;
  if (part.includes(':not(:empty)')) el.append(document.createElement('span'));
  for (const m of bare.matchAll(/\.([\w-]+)/g)) el.classList.add(m[1] as string);
  for (const m of bare.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    el.setAttribute(m[1] as string, m[2] ?? '');
  }
  return el;
}

function fixtureFor(selector: string): HTMLElement {
  const parts = firstAlternative(selector)
    .trim()
    .split(/\s*>\s*|\s+/);
  const nodes = parts.map(compound);
  nodes.forEach((node, i) => nodes[i - 1]?.append(node));
  const leaf = nodes[nodes.length - 1];
  const root = nodes[0];
  if (!leaf || !root) throw new Error(`cannot build a fixture for ${selector}`);
  document.body.append(root);
  if (!leaf.matches(selector)) throw new Error(`fixture does not match ${selector}`);
  return leaf;
}

function computed(el: Element, property: string): string {
  return getComputedStyle(el).getPropertyValue(property);
}

describe('overlay touch-action', () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it.each(SHEETS)('%s: every pointer-events: auto element disallows pinch zoom', (name) => {
    const sheets = loadSheets();
    const sheet = sheets[SHEETS.indexOf(name)];
    if (!sheet) throw new Error(`${name} did not parse into a stylesheet`);
    const selectors = new Set(
      styleRules(sheet.cssRules)
        .filter((r) => r.style.getPropertyValue('pointer-events') === 'auto')
        .flatMap((r) => splitTopLevel(r.selectorText)),
    );
    expect(selectors.size).toBeGreaterThan(0);
    for (const selector of selectors) {
      const el = fixtureFor(selector);
      expect(ALLOWED, selector).toContain(computed(el, 'touch-action'));
      document.body.replaceChildren();
    }
  });
});

const signedOutApi = createApiClient(async () => new Response(null, { status: 401 }));

describe('the real overlay components', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.head.replaceChildren();
  });

  function mount(
    node: () => ReturnType<typeof createElement>,
    interaction?: EventBus<InteractionEvents>,
  ) {
    loadSheets();
    const ui = document.createElement('div');
    ui.id = 'ui';
    document.body.append(ui);
    container = ui;
    root = createRoot(ui);
    const bridge = {
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction:
        interaction ?? new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    };
    act(() =>
      root?.render(createElement(UiProviders, { bridge, api: signedOutApi, children: node() })),
    );
    return { ui, bridge };
  }

  const expectTouch = (ui: HTMLElement, selector: string, value: string) => {
    const el = ui.querySelector(selector);
    if (!el) throw new Error(`${selector} is missing from the rendered component`);
    expect(computed(el, 'touch-action'), selector).toBe(value);
  };

  it('keeps the Sheet drag handle on touch-action: none and the sheet pannable', () => {
    const { ui } = mount(() =>
      createElement(Sheet, {
        panel: 'care',
        label: 'Care',
        title: 'Care',
        onClose: () => undefined,
        children: createElement('p', null, 'body'),
      }),
    );
    expectTouch(ui, '.sheet-grab', 'none');
    expectTouch(ui, '.sheet', 'pan-x pan-y');
  });

  it('keeps the photo pad on touch-action: none and the photo chrome pannable', () => {
    const interaction = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
    const view: PhotoView = {
      capturing: false,
      state: {
        active: true,
        filter: 'natural',
        depthOfField: { enabled: false, available: true, focusDistance: 1, fStop: 2.8 },
        simPaused: false,
        uiHidden: false,
        fov: 50,
      },
    };
    interaction.emit('photo:view', view);
    const { ui } = mount(
      () => createElement('div', null, createElement(PhotoLayer), createElement(PhotoTools)),
      interaction,
    );
    expect(ui.querySelectorAll('.pad-button')).toHaveLength(6);
    for (const pad of Array.from(ui.querySelectorAll('.pad-button'))) {
      expect(computed(pad, 'touch-action')).toBe('none');
    }
    expectTouch(ui, '.photo-bar', 'pan-x pan-y');
    expectTouch(ui, '.photo-tools', 'pan-x pan-y');
  });
});
