import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = readdirSync(import.meta.dirname).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

describe('lifecycle purity', () => {
  it('finds its sources', () => {
    expect(sources).toContain('catchup.ts');
  });

  it.each(sources)('%s reads no clock, randomness, DOM or I/O', (name) => {
    const text = readFileSync(join(import.meta.dirname, name), 'utf8');
    expect(text).not.toMatch(
      /\bMath\.random\b|\bDate\b|\bperformance\.now\b|\bcrypto\b|\b(document|localStorage)\s*[.[]|\bwindow\.[a-z]/,
    );
    expect(text).not.toMatch(/from\s+['"](node:|three|react|fs|path)/);
  });
});
