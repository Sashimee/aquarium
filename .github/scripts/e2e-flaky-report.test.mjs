import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flakySummary } from './e2e-flaky-report.mjs';

test('a clean run reports nothing', () => {
  const log = '  ✓  1 a.spec.ts:3:1 › fine (1.0s)\n  9 passed (2.0m)\n';
  assert.equal(flakySummary('s', log), '');
});

test('a run with retried tests lists exactly those tests', () => {
  const log = [
    '  ✓  1 x',
    '  2 flaky',
    '    [chromium] › e2e/a.spec.ts:3:1 › one',
    '    [chromium] › e2e/b.spec.ts:4:1 › two',
    '  7 passed (2.0m)',
    '',
  ].join('\n');
  assert.equal(
    flakySummary('menus-phone-1', log),
    [
      '### Flaky on menus-phone-1',
      '```',
      '  2 flaky',
      '    [chromium] › e2e/a.spec.ts:3:1 › one',
      '    [chromium] › e2e/b.spec.ts:4:1 › two',
      '```',
      '',
    ].join('\n'),
  );
});

test('a flaky list that ends the log without a pass count is still reported', () => {
  const log = '  1 flaky\n    [chromium] › e2e/a.spec.ts:3:1 › one\n';
  assert.match(flakySummary('s', log), /one/);
});

test('a code fence in a test title cannot close the summary block', () => {
  const log =
    '  1 flaky\n    [chromium] › e2e/a.spec.ts:3:1 › renders ```code``` fine\n  1 passed (1s)\n';
  const out = flakySummary('s', log);
  assert.ok(out.startsWith('### Flaky on s\n````\n'));
  assert.ok(out.endsWith('\n````\n'));
});
