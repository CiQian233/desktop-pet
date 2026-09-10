#!/usr/bin/env node
/**
 * Negative tests for the source-text guard (scripts/check-text.mjs).
 *
 * The guard exists because a PowerShell round-trip corrupted the Chinese UI
 * strings and broke the build. A guard that cannot be shown to catch that damage
 * is worthless, so this injects the two failure modes into scratch copies of a
 * real source file and asserts the guard rejects them:
 *
 *   1. GBK mojibake  (UTF-8 text decoded as the system ANSI codepage)
 *   2. a dropped closing quote (the same corruption, one byte lost)
 *
 * Both scratch files are removed afterwards; no real source is modified.
 *
 *   node scripts/check-text-negative.mjs
 */
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SOURCE = 'src/main/main.ts';
const GUARD = 'scripts/check-text.mjs';

function runGuard() {
  try {
    return { failed: false, output: execFileSync(process.execPath, [GUARD], { encoding: 'utf8' }) };
  } catch (err) {
    return { failed: true, output: String(err.stdout || '') + String(err.stderr || '') };
  }
}

function tryInject(scratch, mutator) {
  copyFileSync(SOURCE, scratch);
  const before = readFileSync(scratch, 'utf8');
  const after = mutator(before);
  if (after === before) {
    unlinkSync(scratch);
    throw new Error('injection did not change the file; the anchor text moved');
  }
  writeFileSync(scratch, after, 'utf8');
  const result = runGuard();
  unlinkSync(scratch);
  if (existsSync(scratch)) throw new Error('scratch file left behind');
  return result;
}

const MOJIBAKE_SCRATCH = 'src/main/zz-guard-mojibake.ts';
const QUOTE_SCRATCH = 'src/main/zz-guard-quote.ts';

const mojibake = tryInject(MOJIBAKE_SCRATCH, (text) =>
  text.replace('\u539f\u5730\u5f85\u673a', '\u9358\u71b7\u6e74\u5bf0\u546e\u6e80'),
);
const quote = tryInject(QUOTE_SCRATCH, (text) =>
  text.replace("label: '\u9000\u51fa'", "label: '\u9000\u51fa"),
);

const checks = [
  ['mojibake is rejected', mojibake.failed],
  ['mojibake is named in the report', mojibake.output.includes('mojibake')],
  ['dropped quote is rejected', quote.failed],
  ['dropped quote is named in the report', quote.output.includes('unterminated single-quoted string')],
];

console.log('--- mojibake injection ---');
console.log(mojibake.output.trim().split('\n').slice(0, 4).join('\n'));
console.log('--- dropped quote injection ---');
console.log(quote.output.trim().split('\n').slice(0, 4).join('\n'));
console.log('--- verdict ---');

let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) bad++;
}

// and the real tree must still be clean
const clean = runGuard();
console.log((clean.failed ? 'FAIL  ' : 'PASS  ') + 'the real source tree passes the guard');
if (!clean.failed) console.log('      ' + clean.output.trim());
if (clean.failed) bad++;

if (bad) {
  console.error(`\n${bad} check(s) failed`);
  process.exit(1);
}
console.log('\nAll guard negative tests passed.');
