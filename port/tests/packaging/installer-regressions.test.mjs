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
