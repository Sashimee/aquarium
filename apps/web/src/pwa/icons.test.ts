import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/generate-icons.mjs', import.meta.url));
const COMMITTED = fileURLToPath(new URL('../../public/icons/', import.meta.url));

describe('icon generator', () => {
  const out = mkdtempSync(join(tmpdir(), 'aquarium-icons-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('reproduces the committed icons byte for byte', () => {
    execFileSync(process.execPath, [SCRIPT, out]);
    const generated = readdirSync(out).sort();
    expect(generated).toEqual(readdirSync(COMMITTED).sort());
    for (const name of generated) {
      expect(readFileSync(join(out, name)).equals(readFileSync(join(COMMITTED, name))), name).toBe(
        true,
      );
    }
  });
});
