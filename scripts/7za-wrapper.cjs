/**
 * Deployed in place of 7za.exe while packaging (see scripts/pack.ps1).
 *
 * electron-builder downloads the winCodeSign helper archive and extracts it
 * with `7za x`. That archive contains two macOS symlinks (libcrypto.dylib /
 * libssl.dylib) which Windows refuses to create without elevation, so 7za exits
 * with code 2 and electron-builder treats the whole build as failed -- even
 * though every Windows binary it actually needs (rcedit) extracted fine.
 *
 * This wrapper strips those two irrelevant entries from a copy of the archive
 * before extracting, so the extraction is clean. Any other subcommand is passed
 * straight through to the real 7za.
 *
 * The real binary sits next to this file as 7za-real.exe.
 */

const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const REAL = join(__dirname, '7za-real.exe');
const SYMLINKS = ['darwin/10.12/lib/libcrypto.dylib', 'darwin/10.12/lib/libssl.dylib'];

function run(args) {
  const r = spawnSync(REAL, args, { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

function main(argv) {
  if (!existsSync(REAL)) {
    process.stderr.write(`7za wrapper: missing ${REAL}\n`);
    return 1;
  }

  // only intercept extraction commands that name an archive
  const cmdIndex = argv.findIndex((a) => !a.startsWith('-') && !a.startsWith('@'));
  const cmd = cmdIndex >= 0 ? argv[cmdIndex] : '';
  const archive = argv[cmdIndex + 1];

  if (cmd !== 'x' && cmd !== 'e') return run(argv);
  if (!archive || !existsSync(archive) || !archive.toLowerCase().endsWith('.7z')) {
    return run(argv);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'pet7za-'));
  const cleaned = join(scratch, 'cleaned.7z');
  try {
    copyFileSync(archive, cleaned);
    // best-effort: a failure here just means the entries were already absent
    spawnSync(REAL, ['d', cleaned, ...SYMLINKS, '-r', '-y'], { stdio: 'ignore' });
    const patched = argv.map((a) => (a === archive ? cleaned : a));
    return run(patched);
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is not worth failing a build over */
    }
  }
}

process.exit(main(process.argv.slice(2)));
