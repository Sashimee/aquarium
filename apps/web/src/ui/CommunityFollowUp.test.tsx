import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedFollowUp } from './Community';

describe('FeedFollowUp', () => {
  it('offers sign-in and sign-up links after a 401', () => {
    const html = renderToStaticMarkup(<FeedFollowUp needs="sign-in" />);
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/sign-up"');
  });

  it('points an unverified account at the inbox, without links', () => {
    const html = renderToStaticMarkup(<FeedFollowUp needs="verify" />);
    expect(html).toContain('verification link');
    expect(html).not.toContain('href=');
  });

  it('renders nothing when waiting is the only remedy', () => {
    expect(renderToStaticMarkup(<FeedFollowUp needs={null} />)).toBe('');
  });
});
