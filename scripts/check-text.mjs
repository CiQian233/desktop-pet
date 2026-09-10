#!/usr/bin/env node
/**
 * Source-text guard.
 *
 * A PowerShell round-trip (`Get-Content` decodes with the system ANSI codepage,
 * `Set-Content -Encoding UTF8` re-encodes) silently destroys non-ASCII source
 * text: it produced GBK mojibake, ate bytes (leaving '?') and removed closing
 * quotes, which broke TypeScript string literals and stopped the app from
 * loading. The damage stayed invisible until the compiled output was inspected.
 *
 * This runs before every build and fails on the fingerprints of that damage:
 *
 *   1. a UTF-8 BOM in a source file
 *   2. U+FFFD replacement characters (a lossy decode already happened)
 *   3. several Chinese characters that legitimately never occur in this project
 *      but did occur in the corruption (checked on CODE files only, so the docs
 *      are free to discuss the incident)
 *   4. an odd number of single quotes on a line of CODE (an eaten quote)
 *
 * Check 4 is stateful: block comments, `//` comments, template literals, ordinary
 * quoted strings and Python docstrings are all tracked, so English possessives
 * ("the pet's feet") and multi-line templates do not produce false positives.
 *
 * To repair damage of this kind, see the worked example in
 * tools/repair-strings.py: it rewrites whole lines matched by their ASCII
 * skeleton rather than trying to reproduce the damaged bytes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['src', 'scripts', 'tools', 'docs'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.ps1', '.py', '.json', '.html', '.css', '.md']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.ps1', '.py', '.html', '.css']);
const SKIP = new Set(['node_modules', 'dist', '.git', '.npm-cache', '.electron-cache', '.builder-cache', 'art', 'assets', 'preview']);

/**
 * Characters that only ever appeared here as GBK-decoded UTF-8. Deliberately not
 * a broad CJK range: that flagged perfectly good text (e.g. "路", "走") which the
 * menu legitimately contains.
 */
const MOJIBAKE = /[\u5997\u5bee\u5d1f\u62cc\u656d\u6d93\u70b2\u71b7\u71ba\u7459\u7587\u7ec0\u7ec9\u8133\u8e87\u9358\u9359\u935a\u9365\u9377\u93b1\u93bd\u93c4\u93c6\u93c8\u941a\u947f\u95ab\u95bb\u9e3f]/;

/** characters that may legitimately contain an apostrophe (English possessives) */
const APOSTROPHE_OK = /@|\bprint\s*\(|"""|it's|don't|pet's|user's|owner's|sprite's|window's|cat's|frame's|meta's|art's|artwork's|probe's|renderer's|controller's|mouse's|window'?s/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.has(name.slice(name.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

/**
 * Scans one line of code, updating the parser state, and reports whether a
 * single-quoted string was left OPEN at end of line. That is the exact shape of
 * the corruption: deleting a closing quote merges the following code into the
 * string literal and TypeScript then fails with "Unterminated string literal".
 *
 * Counting quotes is not enough -- removing one quote can still leave an even
 * count, because the quotes of the following arguments pair up. Only a scan that
 * tracks where each string starts and ends catches it.
 */
function unterminatedString(line, state, ext) {
  if (ext === '.md' || ext === '.json') return false;

  if (ext === '.py' || ext === '.ps1') {
    if (state.inDoc) {
      const end = line.indexOf('"""');
      if (end < 0) return false;
      state.inDoc = false;
      line = line.slice(end + 3);
    }
    const open = line.indexOf('"""');
    if (open >= 0) {
      const close = line.indexOf('"""', open + 3);
      if (close < 0) {
        state.inDoc = true;
        line = line.slice(0, open);
      } else {
        line = line.slice(0, open) + line.slice(close + 3);
      }
    }
    const hash = line.indexOf('#');
    const code = hash >= 0 ? line.slice(0, hash) : line;
    return unterminatedInLine(code, state);
  }

  return unterminatedInLine(line, state);
}

/** the shared scanner: comments and templates are stateful, ordinary strings are not */
function unterminatedInLine(line, state) {
  let open = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (state.inBlock) {
      if (c === '*' && next === '/') { state.inBlock = false; i++; }
      continue;
    }
    if (state.inTemplate) {
      if (c === '\\') { i++; continue; }
      if (c === '`') state.inTemplate = false;
      continue;
    }
    if (open) {
      if (c === '\\') { i++; continue; }
      if (c === open) open = null;
      continue;
    }
    if (c === '/' && next === '*') { state.inBlock = true; i++; continue; }
    if (c === '/' && next === '/') break;
    if (c === '`') { state.inTemplate = true; continue; }
    if (c === '"' || c === "'") open = c;
  }
  if (open === "'") {
    state.openString = true;
    return true;
  }
  return false;
}

const problems = [];
let scanned = 0;

for (const rootName of ROOTS) {
  let files;
  try {
    files = walk(join(ROOT, rootName));
  } catch {
    continue;
  }
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'));
    const buf = readFileSync(file);
    const rel = relative(ROOT, file);
    scanned++;

    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      problems.push(`${rel}: has a UTF-8 BOM (write source as plain UTF-8)`);
    }

    const text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      problems.push(`${rel}: contains U+FFFD replacement characters (a lossy decode already happened)`);
    }
    if (CODE_EXTS.has(ext) && MOJIBAKE.test(text)) {
      problems.push(`${rel}: looks like GBK-decoded mojibake; see tools/repair-strings.py`);
    }

    const state = { inBlock: false, inTemplate: false, inDoc: false, openString: false };
    text.split(/\r?\n/).forEach((line, i) => {
      if (unterminatedString(line, state, ext)) {
        state.openString = false;   // report once per file, not once per following line
        problems.push(`${rel}:${i + 1}: unterminated single-quoted string (a closing quote is missing): ${line.trim().slice(0, 90)}`);
      }
    });
  }
}

if (problems.length) {
  console.error(`source-text guard: ${problems.length} problem(s) in ${scanned} files\n`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  console.error('\nNever rewrite these sources with PowerShell Get-Content/Set-Content; that is what corrupts them.');
  process.exit(1);
}
console.log(`source-text guard: ${scanned} files clean (no BOM, no mojibake, code quotes balanced)`);
