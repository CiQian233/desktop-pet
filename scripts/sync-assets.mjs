/**
 * Assemble everything the app needs at runtime:
 *
 *   dist/renderer/renderer/sprites/   frames + pet.json
 *       -> sibling of index.html, so the renderer fetches them with a plain
 *          relative URL that also works inside the packaged asar
 *   assets/                           tray icon + future plugin/tray art
 *
 * Idempotent; run before tsc (see package.json "build").
 */

import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPRITE_SRC = join(ROOT, 'art', 'sprites', 'chibi-hd');
const RENDERER_OUT = join(ROOT, 'dist', 'renderer', 'renderer');

/** the sprite's native size -- the single source of truth for this run */
const meta = JSON.parse(await readFile(join(SPRITE_SRC, 'meta.json'), 'utf8'));

const problems = [];
const step = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    problems.push(label);
  }
};

/** frame files the renderer actually needs */
function wantedFrame(name) {
  if (!name.endsWith('.png')) return false;
  if (name.includes('@1x') || name.startsWith('_dev_')) return false;
  if (['sheet.png', 'walk_strip.png', 'pat_strip.png'].includes(name)) return false;
  return true;
}

await step('renderer sprites/frames', async () => {
  const dst = join(RENDERER_OUT, 'sprites', 'frames');
  // start from an EMPTY directory: electron-builder packages dist/renderer
  // wholesale, so frames left over from renamed/removed animations would
  // otherwise linger in dist forever and ship inside the exe
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  const names = await readdir(SPRITE_SRC);
  const frames = names.filter(wantedFrame);
  if (frames.length === 0) throw new Error(`no frames found in ${SPRITE_SRC}`);
  for (const name of frames) {
    await cp(join(SPRITE_SRC, name), join(dst, name));
  }
  console.log(`       ${frames.length} frames`);
});

await step('renderer sprites/pet.json', async () => {
  const dst = join(RENDERER_OUT, 'sprites');
  await mkdir(dst, { recursive: true });
  await writeFile(join(dst, 'pet.json'), JSON.stringify(meta, null, 2), 'utf8');
  // verify every referenced frame really exists
  const missing = [];
  for (const [key, anim] of Object.entries(meta.anims)) {
    for (const rel of anim.frames) {
      const file = join(dst, rel);
      if (!existsSync(file)) missing.push(`${key}: ${rel}`);
    }
  }
  if (missing.length) throw new Error(`meta references missing frames: ${missing.join(', ')}`);
  const total = Object.values(meta.anims).reduce((n, a) => n + a.frames.length, 0);
  console.log(`       ${Object.keys(meta.anims).length} anims / ${total} frames verified`);
});

await step('sprite size constants match meta.json', async () => {
  // the native size is hardcoded in a few places (main sizes the window from
  // it, the test scripts assert against it); meta.json is the authority, so a
  // re-export that changed the canvas must not leave them behind
  const [w, h] = meta.native;
  const sites = [
    { file: join(ROOT, 'src', 'main', 'main.ts'), re: /SPRITE_NATIVE\s*=\s*\{\s*w:\s*(\d+)\s*,\s*h:\s*(\d+)\s*\}/ },
    { file: join(ROOT, 'scripts', 'smoke.ps1'), re: /\$NATIVE_W\s*=\s*(\d+)[\s\S]*?\$NATIVE_H\s*=\s*(\d+)/ },
    { file: join(ROOT, 'scripts', 'verify-behaviour.ps1'), re: /\$NW\s*=\s*(\d+)[\s\S]*?\$NH\s*=\s*(\d+)/ },
  ];
  for (const site of sites) {
    const src = await readFile(site.file, 'utf8');
    const m = src.match(site.re);
    if (!m) throw new Error(`sprite size constant not found in ${site.file}`);
    if (Number(m[1]) !== w || Number(m[2]) !== h) {
      throw new Error(`${site.file} says ${m[1]}x${m[2]} but meta.json says ${w}x${h} -- re-export the sprites?`);
    }
  }
  console.log(`       meta.json native ${w}x${h} matches main.ts, smoke.ps1, verify-behaviour.ps1`);
});

await step('renderer shell -> dist', async () => {
  for (const file of ['index.html', 'renderer.css']) {
    await cp(join(ROOT, 'src', 'renderer', file), join(RENDERER_OUT, file));
  }
});

await step('assets/tray.png presence', async () => {
  const p = join(ROOT, 'assets', 'tray.png');
  if (!existsSync(p)) throw new Error('missing assets/tray.png -- run: python tools/make_icons.py');
  const s = await stat(p);
  if (s.size < 100) throw new Error('assets/tray.png looks empty');
});

await step('build/icon.ico presence', async () => {
  const p = join(ROOT, 'build', 'icon.ico');
  if (!existsSync(p)) throw new Error('missing build/icon.ico -- run: python tools/make_icons.py');
});

await step('plugins/ default dir', async () => {
  await mkdir(join(ROOT, 'plugins'), { recursive: true });
  const readme = join(ROOT, 'plugins', 'README.md');
  if (!existsSync(readme)) {
    await writeFile(
      readme,
      '# 插件目录\n\n每个功能一个子文件夹，丢进来即生效（插件宿主开发中，见 PLAN.md §3）。\n',
      'utf8',
    );
  }
});

if (problems.length) {
  console.error(`sync-assets FAILED: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('sync-assets done');
