import assert from 'node:assert/strict';
import test from 'node:test';

let patch;
let reviewed;
try {
  ({ repairConfigEditorRuntimeImport: patch, REVIEWED_CORDIS_FIBER_STATES: reviewed }
    = await import('../../scripts/lib/config-editor-runtime-import.mjs'));
} catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const UNREPAIRED = 'import { FiberState, Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== FiberState.ACTIVE) throw new Error("Configuration plugin is no longer active");\n';

test('config editor compiled output does not import erased const enum at runtime', () => {
  assert.equal(typeof patch, 'function', 'the port owns the missing runtime import repair');
  const result = patch(UNREPAIRED, '4.0.4');
  assert.equal(result.changed, true);
  assert.equal(result.source, 'import { Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== 2 /* Cordis 4.0.4 ACTIVE */) throw new Error("Configuration plugin is no longer active");\n');
});

test('the reviewed target release repairs to the same admitted lifecycle value', () => {
  const result = patch(UNREPAIRED, '4.0.5-alpha.1');
  assert.equal(result.changed, true);
  assert.equal(result.source,
    'import { Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== 2 /* Cordis 4.0.5-alpha.1 ACTIVE */) throw new Error("Configuration plugin is no longer active");\n');
});

test('the alpha.3 reviewed target release repairs to the same admitted lifecycle value', () => {
  const result = patch(UNREPAIRED, '4.0.5-alpha.2');
  assert.equal(result.changed, true);
  assert.equal(result.source,
    'import { Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== 2 /* Cordis 4.0.5-alpha.2 ACTIVE */) throw new Error("Configuration plugin is no longer active");\n');
});

test('already inlined generated code is not modified', () => {
  const source = 'import { Service } from "@deepseek-ai/cordis";\nif (fiber.state !== 2) throw new Error("inactive");';
  assert.deepEqual(patch(source, '4.0.4'), { changed: false, source });
  assert.deepEqual(patch(source, '4.0.5-alpha.1'), { changed: false, source });
});

test("the target's shipped ConfigEditor needs no repair at all", () => {
  // The real materialized artifact (`@deepseek-ai/dsh-config-editor/lib/index.js`)
  // already carries the inlined number and mentions FiberState nowhere, so the
  // repair must report "not required" rather than a shape failure. The previous
  // unconditional version gate rejected this payload before it could say so.
  const shipped = 'if (fiber.state !== 2) throw new Error("Configuration plugin is no longer active");';
  assert.deepEqual(patch(shipped, '4.0.5-alpha.1'), { changed: false, source: shipped });
});

test('unknown enum use and duplicate guards fail closed', () => {
  assert.throws(() => patch('FiberState.PENDING', '4.0.4'), /Unreviewed ConfigEditor/);
  const importLine = 'import { FiberState, Service, resolveConfig } from "@deepseek-ai/cordis";';
  assert.throws(() => patch(importLine + '\nif (fiber.state !== FiberState.ACTIVE) {}\nif (fiber.state !== FiberState.ACTIVE) {}', '4.0.4'), /Unreviewed ConfigEditor/);
});

test('an unreviewed framework version requires review rather than guessed enum values', () => {
  // The accepted set is exact. A neighbouring name is not admitted by a prefix,
  // a range, or a normalisation: adding a release means reading its enum.
  for (const version of ['4.0.6', '4.0.5-alpha.3', '4.0.4 ', ' 4.0.5-alpha.1', ' 4.0.5-alpha.2', '', 'unknown']) {
    assert.throws(() => patch('const valid = true;', version), /Unreviewed Cordis version/,
      `${JSON.stringify(version)} must not be admitted`);
  }
  assert.throws(() => patch('const valid = true;'), /Unreviewed Cordis version/);
});

test('the active-fiber lifecycle admission is retained', () => {
  const { source } = patch(UNREPAIRED, '4.0.4');
  const guard = new Function('fiber', source.replace(/^import[^\n]+\n/, ''));
  assert.doesNotThrow(() => guard({ state: 2 }));
  for (const state of [0, 1, 3, 4]) assert.throws(() => guard({ state }), /no longer active/);
});

test('the transcription follows the reviewed value rather than a hardcoded 2', () => {
  // Drives the repair with a different reviewed value to prove the emitted
  // constant comes from the table. A blind `2` literal would fail here.
  const result = patch(UNREPAIRED, 'test-release', { 'test-release': 5 });
  assert.equal(result.changed, true);
  assert.ok(result.source.includes('fiber.state !== 5 /* Cordis test-release ACTIVE */'),
    `the reviewed value must be used, got: ${result.source}`);
  assert.ok(!result.source.includes('!== 2 '), 'no hardcoded 2 may survive');
});

test('an invalid reviewed value is refused rather than emitted', () => {
  for (const table of [{ v: -1 }, { v: 2.5 }, { v: '2' }, { v: null }]) {
    assert.throws(() => patch(UNREPAIRED, 'v', table), /must be a non-negative integer/);
  }
  assert.throws(() => patch(UNREPAIRED, 'constructor', {}), /Unreviewed Cordis version/,
    'an inherited object member is not a reviewed version');
});

test('the reviewed table agrees with the const enum in its own checkout', async () => {
  const { readFileSync } = await import('node:fs');
  const { existsSync } = await import('node:fs');
  assert.ok(Object.isFrozen(reviewed), 'the table must be frozen');
  for (const [version, active] of Object.entries(reviewed)) {
    assert.ok(Number.isSafeInteger(active) && active >= 0, `${version} must map to a non-negative integer`);
  }
  assert.equal(reviewed['4.0.4'], 2, 'the historical reviewed release admits ACTIVE at 2');

  // Re-derive the TARGET entry from the reference checkout so the table cannot
  // drift from the source it describes.
  const root = new URL('../../../_upstream/', import.meta.url);
  const manifest = new URL('vendor/cordis/package.json', root);
  const fiber = new URL('vendor/cordis/src/fiber.ts', root);
  assert.ok(existsSync(manifest) && existsSync(fiber), 'the reference checkout ships vendored Cordis');
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  const members = readFileSync(fiber, 'utf8')
    .match(/export const enum FiberState\s*\{([\s\S]*?)\}/)[1]
    .split(',').map(value => value.trim()).filter(Boolean);
  assert.equal(members.indexOf('ACTIVE'), 2, 'ACTIVE is still the third declared member');
  assert.equal(reviewed[version], members.indexOf('ACTIVE'),
    `the reviewed table must record ${version} from its own source, not a guess`);
});

test('production staging owns the repair and pins its source before sealing', async () => {
  const { readFileSync } = await import('node:fs');
  const stage = readFileSync(new URL('../../scripts/lib/runtime-payload.psm1', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../../scripts/build.ps1', import.meta.url), 'utf8');
  assert.ok(stage.includes("import(new URL('./config-editor-runtime-import.mjs', pathToFileURL(lockHelper)).href)"));
  assert.ok(stage.includes('repairConfigEditorRuntimeImport(readFileSync(editorPath, \'utf8\'), cordisVersion)'));
  assert.ok(build.includes("'config-editor-runtime-import.mjs'"), 'transform must be a hashed payload input');
});
