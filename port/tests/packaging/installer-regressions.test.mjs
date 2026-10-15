import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const installerDir = path.join(repoRoot, 'port/installer');
const readInstaller = (name) => readFile(path.join(installerDir, name), 'utf8');
const readPackagingTest = (name) => readFile(path.join(repoRoot, 'port/tests/packaging', name), 'utf8');

function functionBody(source, name, uninstall = false) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = uninstall ? 'un\\.' : '';
  const match = source.match(new RegExp(`Function ${prefix}${escaped}\\b([\\s\\S]*?)\\nFunctionEnd`, 'm'));
  assert.ok(match, `${uninstall ? 'un.' : ''}${name} exists`);
  return match[1];
}

for (const [label, isUninstall] of [['install', false], ['uninstall', true]]) {
  test(`${label} process observation rejects missing and malformed plugin results`, async () => {
    const processSource = await readInstaller('installer-process.nsh');
    const scan = functionBody(processSource, 'DshProcessCountByName', isUninstall);
    const plugin = 'nsis_tauri_utils::FindProcessCurrentUser';
    const pluginAt = scan.indexOf(plugin);
    const resultPopAt = scan.indexOf('Pop $dshScanResult');
    const sentinelPushAt = scan.indexOf('Push "DSH_PROCESS_SCAN_NO_RESULT"');
    const indeterminateAt = scan.indexOf('StrCpy $dshNameRunningCount -1');

    assert.notEqual(pluginAt, -1, 'the real plugin observation boundary remains visible');
    assert.ok(sentinelPushAt >= 0 && sentinelPushAt < pluginAt, 'a private stack sentinel is pushed before the plugin call so a missing result cannot pop a stale value or the function return address');
    assert.ok(resultPopAt > pluginAt, 'the observation result is popped after the plugin call');
    assert.ok(indeterminateAt > resultPopAt, 'each scan starts indeterminate before interpreting any observation');
    assert.match(scan, /\$dshScanResult\s*==\s*"DSH_PROCESS_SCAN_NO_RESULT"/, 'an absent plugin push is distinguished from a returned result');
    assert.match(scan, /Pop \$dshScanStackCheck[\s\S]*?\$dshScanStackCheck\s*==\s*"DSH_PROCESS_SCAN_NO_RESULT"/, 'the sentinel is verified before the plugin result can be trusted');
    assert.match(scan, /\$dshScanResult\s*==\s*"0"/, 'only the exact string observation 0 means present');
    assert.match(scan, /\$dshScanResult\s*==\s*"1"/, 'only the exact string observation 1 means absent');
    assert.doesNotMatch(scan, /\$dshScanResult\s*=\s*[01](?![\w"])/, 'numeric coercion cannot turn malformed plugin output into a valid observation');
  });
}

test('GUI finish callback and template success path share the idempotent relaunch boundary', async () => {
  const [template, hooks, processSource] = await Promise.all([
    readInstaller('installer-template.nsi'),
    readInstaller('installer-hooks.nsh'),
    readInstaller('installer-process.nsh'),
  ]);
  const runMain = functionBody(template, 'RunMainBinary');
  const installSuccess = functionBody(template, '.onInstSuccess');
  const relaunch = functionBody(processSource, 'DshInstallerRelaunch');

  assert.match(template, /!define MUI_FINISHPAGE_RUN\s*\n!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary/, 'the normal GUI finish-page checkbox still owns the ordinary user choice');
  assert.match(runMain, /Call DshInstallerRelaunch/, 'the finish callback uses the common relaunch boundary');
  assert.doesNotMatch(runMain, /RunAsUser/, 'the finish callback cannot bypass relaunch idempotence');
  assert.match(installSuccess, /Call DshInstallerRelaunch/, 'silent/passive template success uses the same boundary');
  assert.doesNotMatch(installSuccess, /RunAsUser/, 'template success cannot bypass relaunch idempotence');
  assert.match(relaunch, /\$dshRelaunchHandled\s*=\s*"1"[\s\S]*?Return/, 'the shared boundary suppresses the second call');
  assert.match(hooks, /Call DshInstallerRelaunch/, 'the existing hook relaunch request remains on the same boundary');
  assert.match(hooks, /If} \$PassiveMode = 1[\s\S]*?If} \$dshRelaunchRequested = "1"[\s\S]*?If} \$\{Silent\}[\s\S]*?ElseIf} \$PassiveMode = 1[\s\S]*?Call DshInstallerRelaunch/, 'silent and passive behavior still defers to the template while GUI behavior keeps its hook relaunch');
});

test('installer comments describe the process checks as non-atomic and best-effort', async () => {
  const [template, hooks, processSource] = await Promise.all([
    readInstaller('installer-template.nsi'),
    readInstaller('installer-hooks.nsh'),
    readInstaller('installer-process.nsh'),
  ]);
  const comments = `${template}\n${hooks}\n${processSource}`;
  assert.doesNotMatch(comments, /clos(?:e|es|ing) the check gap/i, 'no comment claims repeated checks close the race');
  assert.match(comments, /narrows?[^\n]{0,100}(?:not|does not|cannot) close/i, 'the narrower window is not described as closed');
  assert.match(processSource, /not an atomic installation\s+lease/i, 'the remaining post-observation race is explicit');
});

test('legacy NSIS and WiX upgrade uninstallers remain unsupported without disabling upgrades', async () => {
  const [template, provenanceText] = await Promise.all([
    readInstaller('installer-template.nsi'),
    readInstaller('installer-template-provenance.json'),
  ]);
  const provenance = JSON.parse(provenanceText);
  assert.equal((template.match(/ExecWait '\$R1' \$0/g) ?? []).length, 2, 'both existing NSIS and WiX ordinary upgrade uninstaller branches remain');
  assert.match(provenance.unsupportedUpgradeBoundary, /ordinary upgrade/i, 'the ordinary upgrade path is explicitly retained');
  assert.match(provenance.unsupportedUpgradeBoundary, /NSIS/i, 'the old NSIS uninstaller boundary is named');
  assert.match(provenance.unsupportedUpgradeBoundary, /Wi-?X/i, 'the old WiX uninstaller boundary is named');
  assert.match(provenance.unsupportedUpgradeBoundary, /new template.*(?:does not|cannot).*protect|guards?.*(?:do not|cannot).*protect/i, 'new guards are not credited with protecting historical uninstaller bytes');
});

test('installer contract is a registered Node test suite with explicit hashed package provenance', async () => {
  const [contract, provenanceText] = await Promise.all([
    readPackagingTest('installer-contract.test.mjs'),
    readInstaller('installer-template-provenance.json'),
  ]);
  const provenance = JSON.parse(provenanceText);
  assert.ok(/from ['"]node:test['"]/.test(contract), 'the contract suite imports node:test');
  assert.ok(/\btest\s*\(/.test(contract), 'contract assertions are registered tests');
  assert.ok(!/execFileSync\s*\(\s*['"]cargo['"]/.test(contract), 'the test no longer depends on undeclared bare cargo lookup');
  assert.ok(/tauri-cli-[^\n]*Cargo\.toml|tauriCliPackageManifestSha256/.test(contract), 'the installed CLI package metadata is used for provenance');
  assert.ok(/tauri-bundler-[^\n]*Cargo\.toml|tauriBundlerPackageManifestSha256/.test(contract), 'the installed bundler package metadata is used for provenance');
  assert.match(provenance.tauriCliPackageManifestSha256 ?? '', /^[a-f0-9]{64}$/, 'the CLI manifest hash is pinned');
  assert.match(provenance.tauriBundlerPackageManifestSha256 ?? '', /^[a-f0-9]{64}$/, 'the bundler manifest hash is pinned');
});

// ---------------------------------------------------------------------------
// NSIS include-order invariants.
//
// The registered template `!include`s the hooks file IN PLACE, so the order of
// the template's own directives decides whether the generated installer compiles
// at all. Both defects below were reproduced with real makensis (NSIS 3.11) while
// fixing the bundle:
//
//   * a plugin command compiled before its directory is registered aborts with
//     `Plugin not found, cannot call nsis_tauri_utils::FindProcessCurrentUser`;
//   * a second `Var` for an already declared name aborts with
//     `Error: variable "X" already declared`;
//   * deleting the module's declarations instead is NOT caught by the build - the
//     name compiles to nothing (warning 6000) and the guard's `$UpdateMode` branch
//     silently degenerates.
//
// `nsis-hooks-compile.ps1` compiles the accepted and the rejected arrangements for
// real. The assertions below pin the same properties from the source text, so a
// regression is reported by a cheap suite even where no NSIS toolchain exists.

const lineIndex = (source, pattern, label) => {
  const index = source.split(/\r?\n/).findIndex((line) => pattern.test(line));
  assert.notEqual(index, -1, `${label} exists`);
  return index;
};

test('the registered template registers the additional plugin directory before the hooks include', async () => {
  const template = await readInstaller('installer-template.nsi');
  const hooksInclude = lineIndex(template, /^!include "\{\{installer_hooks\}\}"$/, 'the hooks include');
  const signedPluginDir = lineIndex(template, /^!addplugindir "\{\{signed_plugins_path\}\}"$/, 'the signed plugin directory');
  const additionalPluginDir = lineIndex(template, /^!addplugindir "\{\{additional_plugins_path\}\}"$/, 'the additional plugin directory');

  assert.ok(signedPluginDir < hooksInclude, 'the signed plugin directory is on the search path before the hooks are compiled');
  assert.ok(additionalPluginDir < hooksInclude,
    'nsis_tauri_utils is on the search path before installer-process.nsh names it, which is the "Plugin not found" defect');
  // The stock template's own registration site further down is retained for its
  // shape; the early directive above is what makes the bundle compile.
  assert.match(template, /^!addplugindir "\$\{ADDITIONALPLUGINSPATH\}"$/m, 'the stock additional-plugin registration remains');
});

test('exactly one file declares the installer mode Vars, and it is compiled above the hooks include', async () => {
  const [template, processSource] = await Promise.all([
    readInstaller('installer-template.nsi'),
    readInstaller('installer-process.nsh'),
  ]);
  const templateLines = template.split(/\r?\n/);
  const hooksInclude = lineIndex(template, /^!include "\{\{installer_hooks\}\}"$/, 'the hooks include');
  const sentinel = lineIndex(template, /^!define DSH_TEMPLATE_MODE_VARS_DECLARED$/, 'the mode-Var sentinel');
  assert.ok(sentinel < hooksInclude, 'the sentinel is defined before the hooks include, so the module skips its fallback');

  for (const name of ['PassiveMode', 'UpdateMode']) {
    const declaredAt = templateLines
      .map((line, index) => (line.trim() === `Var ${name}` ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(declaredAt.length, 1, `the template declares ${name} exactly once (a duplicate is "already declared")`);
    assert.ok(declaredAt[0] < hooksInclude,
      `${name} is declared before the hooks include, or the module reads it before it exists`);
  }

  // The module keeps a fallback for callers with no template at all, but only
  // inside the sentinel guard, so the two files can never both declare the name.
  const processLines = processSource.split(/\r?\n/);
  const guardStart = processLines.findIndex((line) => line.trim() === '!ifndef DSH_TEMPLATE_MODE_VARS_DECLARED');
  assert.notEqual(guardStart, -1, 'the module guards its fallback declarations with the template sentinel');
  const guardEnd = processLines.findIndex((line, index) => index > guardStart && line.trim() === '!endif');
  assert.ok(guardEnd > guardStart, 'the module fallback guard closes');

  for (const name of ['PassiveMode', 'UpdateMode']) {
    const declaredAt = processLines
      .map((line, index) => (line.trim() === `Var ${name}` ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(declaredAt.length, 1, `the module declares ${name} exactly once`);
    assert.ok(declaredAt[0] > guardStart && declaredAt[0] < guardEnd,
      `${name} is declared only inside the sentinel guard`);
  }

  // A `Var` that is compiled after the first read of the name does not fail the
  // build: the name expands to nothing (warning 6000) and the guard's comparison
  // runs against an empty string. Keep the declaration above that read.
  const codeLines = processLines.filter((line) => !line.trimStart().startsWith(';'));
  const firstRead = codeLines.findIndex((line) => /\$UpdateMode/.test(line));
  assert.notEqual(firstRead, -1, 'the module still reads $UpdateMode');
  const codeGuardEnd = codeLines.findIndex((line, index) => index > codeLines
    .findIndex((candidate) => candidate.trim() === '!ifndef DSH_TEMPLATE_MODE_VARS_DECLARED') && line.trim() === '!endif');
  assert.ok(codeGuardEnd >= 0 && codeGuardEnd < firstRead,
    'every declaration of the mode name is compiled before the first read, so no 6000 warning can appear');
});

test('the registered template registers the additional plugin directory exactly once', async () => {
  const template = await readInstaller('installer-template.nsi');

  // The early registration is what makes `nsis_tauri_utils` resolvable at the
  // hooks include; the sentinel is what stops the stock site from registering the
  // SAME directory again. MEASURED (NSIS 3.11, real DLL): a second `!addplugindir`
  // for a directory that already provided a resolved plugin makes the next command
  // naming it abort with `Plugin command nsis_tauri_utils::SemverCompare conflicts
  // with a plugin in another directory!` - even when the path is identical.
  assert.match(template, /^!define DSH_ADDITIONAL_PLUGINS_REGISTERED$/m,
    'the early additional-plugin registration announces itself with a sentinel');
  assert.match(template,
    /^!ifndef DSH_ADDITIONAL_PLUGINS_REGISTERED\n!addplugindir "\$\{ADDITIONALPLUGINSPATH\}"\n!endif$/m,
    'the stock additional-plugin site emits only when the early registration did not happen');
  assert.match(template, /\{\{#if additional_plugins_path\}\}\n!addplugindir "\{\{additional_plugins_path\}\}"\n!define DSH_ADDITIONAL_PLUGINS_REGISTERED\n\{\{\/if\}\}/,
    'the early block registers the directory and sets the sentinel together');
  assert.match(template, /^!define ADDITIONALPLUGINSPATH "\{\{additional_plugins_path\}\}"$/m,
    'the stock site and the early block name the same bundler data key, so the sentinel is the only thing preventing a duplicate');

  // Exactly three directives, and the only unguarded ones are the two early
  // registrations: `signed_plugins_path` and the additional directory.
  const directives = template.split(/\r?\n/).filter((line) => line.startsWith('!addplugindir '));
  assert.equal(directives.length, 3, `exactly three !addplugindir directives, found ${directives.length}`);
  assert.match(directives[0], /\{\{signed_plugins_path\}\}/, 'the signed directory is registered first');
  assert.match(directives[1], /\{\{additional_plugins_path\}\}/, 'the additional directory is registered second');
  assert.match(directives[2], /\$\{ADDITIONALPLUGINSPATH\}/, 'the stock site is the guarded third');

  // In either rendering - signed present or absent - at most one of the two
  // additional-directory emitters fires, so no rendering registers a directory
  // that has already supplied a resolved plugin.
  const guardIndex = template.split(/\r?\n/).findIndex((line) => line === '!ifndef DSH_ADDITIONAL_PLUGINS_REGISTERED');
  const sentinelIndex = template.split(/\r?\n/).findIndex((line) => line === '!define DSH_ADDITIONAL_PLUGINS_REGISTERED');
  assert.ok(sentinelIndex >= 0 && sentinelIndex < guardIndex,
    'the sentinel is defined before the guard that reads it, in every rendering');
});

test('the declared hook compile suite still preflights the template ordering and its rejected variants', async () => {
  const suite = await readPackagingTest('nsis-hooks-compile.ps1');
  assert.match(suite, /nsis\\template-order-fixture\.nsi/, 'the ordering fixture is compiled by the declared suite');
  for (const mode of ['fixed', 'fixed-unsigned', 'late-plugin', 'duplicate-additional-dir',
    'duplicate-var', 'process-vars-removed']) {
    assert.ok(suite.includes(`'${mode}'`), `the '${mode}' ordering variant is still exercised`);
  }
  assert.match(suite, /Plugin not found, cannot call nsis_tauri_utils::FindProcessCurrentUser/,
    'the late-plugin failure is asserted through makensis\'s own message');
  assert.match(suite, /Plugin command nsis_tauri_utils::SemverCompare conflicts with a plugin in another directory!/,
    'the duplicate-directory conflict is asserted through makensis\'s own message');
  assert.match(suite, /already declared/, 'the duplicate-Var failure is asserted');
  assert.match(suite, /6000: unknown variable\/constant "UpdateMode"/,
    'the silently degraded variant is asserted through its warning, not through a build failure');
  // Both bundler plugin layouts are compiled: the copied signed tree
  // (`windows().can_sign() == true`) and the toolset's own additional directory.
  assert.match(suite, /DSH_FIXTURE_SIGNED_PLUGINS_DIR/, 'the signed layout is supplied to the fixture');
  assert.match(suite, /signedLayoutAdditional/, 'the signed layout uses the copied tree\'s nested additional directory');
});

test('the ordering fixture stays ASCII and never executes anything it compiles', async () => {
  const bytes = await readFile(path.join(repoRoot, 'port/tests/packaging/nsis/template-order-fixture.nsi'));
  assert.equal([...bytes].filter((byte) => byte > 127).length, 0, 'the ordering fixture is pure ASCII');
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'the ordering fixture has no UTF-8 BOM');
  const text = bytes.toString('utf8');
  assert.match(text, /WriteUninstaller/, 'the fixture emits an uninstaller, so the un. hooks really compile');
  for (const banned of ['ExecWait', 'Exec ', 'RunAsUser', 'ShellExec']) {
    assert.ok(!new RegExp(`^\\s*${banned}`, 'm').test(text),
      `the fixture never executes a program (${banned.trim()} is compile-only here)`);
  }
});
