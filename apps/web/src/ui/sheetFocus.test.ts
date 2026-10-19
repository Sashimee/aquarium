import { describe, expect, it } from 'vitest';
import { ownOpener } from './sheetFocus';

const el = (opener?: string) => ({ dataset: opener === undefined ? {} : { opener } });

describe('ownOpener', () => {
  it('keeps the dock button of the same panel', () => {
    const shop = el('shop');
    expect(ownOpener(shop, 'shop')).toBe(shop);
  });

  it('drops another panel dock button so the sheet finds its own', () => {
    expect(ownOpener(el('feed'), 'shop')).toBeNull();
  });

  it('keeps focus on an element that is not a dock button', () => {
    const other = el();
    expect(ownOpener(other, 'shop')).toBe(other);
  });

  it('has no opener when nothing was focused', () => {
    expect(ownOpener(null, 'shop')).toBeNull();
  });
});
