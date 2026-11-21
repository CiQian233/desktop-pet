import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import core from '../dist/main/config-core.js';

const {
  DEFAULT_CONFIG,
  coerceConfig,
  loadConfigFile,
  saveConfigFile,
} = core;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'calico-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('legacy config is migrated and invalid values are rejected', () => {
  const out = coerceConfig({
    scale: 4,
    mode: 'roam',
    roamSpeed: 'fast',
    facing: -1,
    displayId: 42,
    batterySaver: false,
    petName: '  小团子  ',
    personality: 'lively',
    bubblesEnabled: false,
    randomChatter: false,
    naturalEnabled: false,
    naturalFrequency: 'high',
    autostart: 'yes',
    x: Number.POSITIVE_INFINITY,
  });
  assert.equal(out.configVersion, 1);
  assert.equal(out.scale, 4);
  assert.equal(out.mode, 'roam');
  assert.equal(out.roamSpeed, 'fast');
  assert.equal(out.facing, -1);
  assert.equal(out.displayId, 42);
  assert.equal(out.batterySaver, false);
  assert.equal(out.petName, '小团子');
  assert.equal(out.personality, 'lively');
  assert.equal(out.bubblesEnabled, false);
  assert.equal(out.randomChatter, false);
  assert.equal(out.naturalEnabled, false);
  assert.equal(out.naturalFrequency, 'high');
  assert.equal(coerceConfig({ naturalFrequency: 'extreme' }).naturalFrequency, DEFAULT_CONFIG.naturalFrequency);
  assert.equal(coerceConfig({ naturalEnabled: 'no' }).naturalEnabled, DEFAULT_CONFIG.naturalEnabled);
  assert.equal(coerceConfig({ petName: '   ' }).petName, DEFAULT_CONFIG.petName);
  assert.equal(coerceConfig({ personality: 'unknown' }).personality, DEFAULT_CONFIG.personality);
  assert.equal(out.autostart, false);
  assert.equal(out.x, null);
  assert.equal(coerceConfig({ scale: 99 }).scale, DEFAULT_CONFIG.scale);
  assert.equal(coerceConfig(null).mode, DEFAULT_CONFIG.mode);
});

test('atomic save round-trips and creates a known-good backup', (t) => {
  const file = join(tempDir(t), 'pet-config.json');
  const expected = coerceConfig({ scale: 6, mode: 'follow', batterySaver: false });
  saveConfigFile(file, expected);
  assert.deepEqual(loadConfigFile(file).data, expected);
  assert.deepEqual(loadConfigFile(`${file}.bak`).data, expected);
  assert.equal(readdirSync(join(file, '..')).some((name) => name.endsWith('.tmp')), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).configVersion, 1);
});

test('corrupt main config is preserved and recovered from backup', (t) => {
  const file = join(tempDir(t), 'pet-config.json');
  const expected = coerceConfig({ scale: 2, mode: 'roam', facing: -1 });
  saveConfigFile(file, expected);
  writeFileSync(file, '{ broken json', 'utf8');
  const result = loadConfigFile(file);
  assert.equal(result.source, 'backup');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, expected);
  assert.equal(readdirSync(join(file, '..')).some((name) => name.includes('.corrupt')), true);
});

test('unreadable main and backup fall back without throwing', (t) => {
  const file = join(tempDir(t), 'pet-config.json');
  writeFileSync(file, '{ no', 'utf8');
  writeFileSync(`${file}.bak`, '{ also no', 'utf8');
  const result = loadConfigFile(file);
  assert.equal(result.source, 'default');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.data, DEFAULT_CONFIG);
});
