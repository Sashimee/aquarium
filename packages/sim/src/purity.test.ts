import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('packages/sim purity', () => {
  const files = sources(join(root, 'src'));

  it('finds the sources it is meant to scan', () => {
    expect(files.some((f) => f.endsWith('world.ts'))).toBe(true);
  });

  it.each(files)('%s imports neither three nor React and touches no DOM', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/from\s+['"](three|react|react-dom)(\/[^'"]*)?['"]/);
    expect(text).not.toMatch(
      /\b(document|window|localStorage)\s*[.[]|\brequestAnimationFrame\s*\(/,
    );
    expect(text).not.toMatch(/\bMath\.random\b|\bDate\.now\b/);
  });

  // The bridge owns the wall clock that paces steps; everything it drives must not read one.
  const deterministic = files.filter((f) => !f.endsWith('bridge.ts'));

  it.each(deterministic)('%s reads no clock and no ambient randomness', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(
      /\bMath\.random\b|\bDate\.now\b|\bnew\s+Date\s*\(|\bperformance\.now\b|\bcrypto\.(getRandomValues|randomUUID)\b/,
    );
  });
});
