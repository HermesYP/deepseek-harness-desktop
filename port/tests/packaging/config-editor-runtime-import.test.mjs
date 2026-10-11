import assert from 'node:assert/strict';
import test from 'node:test';

let patch;
try { ({ repairConfigEditorRuntimeImport: patch } = await import('../../scripts/lib/config-editor-runtime-import.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('config editor compiled output does not import erased const enum at runtime', () => {
  assert.equal(typeof patch, 'function', 'the port owns the missing runtime import repair');
  const before = 'import { FiberState, Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== FiberState.ACTIVE) throw new Error("Configuration plugin is no longer active");\n';
  const result = patch(before, '4.0.4');
  assert.equal(result.changed, true);
  assert.equal(result.source, 'import { Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== 2 /* Cordis 4.0.4 ACTIVE */) throw new Error("Configuration plugin is no longer active");\n');
});

test('already inlined generated code is not modified', () => {
  const source = 'import { Service } from "@deepseek-ai/cordis";\nif (fiber.state !== 2) throw new Error("inactive");';
  assert.deepEqual(patch(source, '4.0.4'), { changed: false, source });
});

test('unknown enum use and duplicate guards fail closed', () => {
  assert.throws(() => patch('FiberState.PENDING', '4.0.4'), /Unreviewed ConfigEditor/);
  const importLine = 'import { FiberState, Service, resolveConfig } from "@deepseek-ai/cordis";';
  assert.throws(() => patch(importLine + '\nif (fiber.state !== FiberState.ACTIVE) {}\nif (fiber.state !== FiberState.ACTIVE) {}', '4.0.4'), /Unreviewed ConfigEditor/);
});

test('a future framework version requires review rather than guessed enum values', () => {
  assert.throws(() => patch('const valid = true;', '4.0.5'), /Unreviewed Cordis version/);
  assert.throws(() => patch('const valid = true;'), /Unreviewed Cordis version/);
});

test('the active-fiber lifecycle admission is retained', () => {
  const before = 'import { FiberState, Service, resolveConfig } from "@deepseek-ai/cordis";\nif (fiber.state !== FiberState.ACTIVE) throw new Error("inactive");';
  const { source } = patch(before, '4.0.4');
  const guard = new Function('fiber', source.replace(/^import[^\n]+\n/, ''));
  assert.doesNotThrow(() => guard({ state: 2 }));
  for (const state of [0, 1, 3, 4]) assert.throws(() => guard({ state }), /inactive/);
});

test('the transcription agrees with the preserved upstream const enum', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../_upstream/vendor/cordis/src/fiber.ts', import.meta.url), 'utf8');
  const members = source.match(/export const enum FiberState\s*\{([\s\S]*?)\}/)[1]
    .split(',').map(value => value.trim()).filter(Boolean);
  assert.equal(members.indexOf('ACTIVE'), 2);
});

test('production staging owns the repair and pins its source before sealing', async () => {
  const { readFileSync } = await import('node:fs');
  const stage = readFileSync(new URL('../../scripts/lib/runtime-payload.psm1', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../../scripts/build.ps1', import.meta.url), 'utf8');
  assert.ok(stage.includes("import(new URL('./config-editor-runtime-import.mjs', pathToFileURL(lockHelper)).href)"));
  assert.ok(stage.includes('repairConfigEditorRuntimeImport(readFileSync(editorPath, \'utf8\'), cordisVersion)'));
  assert.ok(build.includes("'config-editor-runtime-import.mjs'"), 'transform must be a hashed payload input');
});
