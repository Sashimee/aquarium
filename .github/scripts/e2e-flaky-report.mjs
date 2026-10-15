import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function flakyBlock(log) {
  const lines = log.split('\n');
  const start = lines.findIndex((line) => /^ +\d+ flaky\b/.test(line));
  if (start === -1) return '';
  const rest = lines.slice(start);
  const end = rest.findIndex(
    (line, i) => i > 0 && /^ +\d+ (passed|skipped|did not run|failed)\b/.test(line),
  );
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trimEnd();
}

export function flakySummary(shard, log) {
  const block = flakyBlock(log);
  if (!block) return '';
  const longestRun = Math.max(0, ...(block.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `### Flaky on ${shard}\n${fence}\n${block}\n${fence}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [logPath, shard] = process.argv.slice(2);
  if (!logPath || !shard) {
    console.error('usage: e2e-flaky-report.mjs <log file> <shard name>');
    process.exit(2);
  }
  process.stdout.write(flakySummary(shard, readFileSync(logPath, 'utf8')));
}
