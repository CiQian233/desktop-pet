/**
 * TypeScript (with moduleResolution "bundler") leaves relative import
 * specifiers without a file extension, which bare ES modules in Chromium refuse
 * to resolve. This rewrites them in the compiled renderer output.
 *
 * Runs after tsc as part of `npm run build`.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_OUT = join(ROOT, 'dist', 'renderer', 'renderer');

/** './core/atlas' -> './core/atlas.js'  (already-suffixed specifiers untouched) */
const SPECIFIER = /(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+?)\2/g;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

if (!existsSync(RENDERER_OUT)) {
  console.error(`fix-esm-imports: ${RENDERER_OUT} missing -- run tsc first`);
  process.exit(1);
}

let files = 0;
let rewrites = 0;

for (const file of await walk(RENDERER_OUT)) {
  const src = await readFile(file, 'utf8');
  const out = src.replace(SPECIFIER, (match, prefix, quote, spec) => {
    if (/\.(js|json|mjs|css)$/.test(spec)) return match;
    rewrites += 1;
    return `${prefix}${quote}${spec}.js${quote}`;
  });
  if (out !== src) {
    await writeFile(file, out, 'utf8');
    files += 1;
  }
}

console.log(`fix-esm-imports: ${rewrites} specifiers in ${files} files`);
