import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const updateFlow = await readFile(path.join(repoRoot, 'port/src-tauri/app/src/update_flow.rs'), 'utf8');
const config = JSON.parse(await readFile(path.join(repoRoot, 'port/src-tauri/app/tauri.conf.json'), 'utf8'));
const installerDir = path.join(repoRoot, 'port/installer');

// This regression reads the real production helper and its call site; it does not
// build an unrelated test argument list or launch a process stand-in.
const helper = updateFlow.match(/fn windows_update_installer_arguments\s*\(\)\s*->\s*\[&'static str;\s*3\]\s*\{([\s\S]*?)\n\}/);
assert.ok(helper, 'production Windows installer argument boundary is defined');
const actualArguments = [...helper[1].matchAll(/"([^"\\]*)"/g)].map((match) => match[1]);
assert.deepEqual(actualArguments, ['/S', '/UPDATE', '/R'], 'the shared production boundary emits the exact Tauri update contract in order');
assert.match(updateFlow, /command\.args\(windows_update_installer_arguments\(\)\)/, 'the Windows production launcher uses the shared boundary');

const nsisConfig = config.bundle.windows.nsis;
assert.equal(nsisConfig.template, '../../installer/installer-template.nsi', 'Tauri registers the repository-owned NSIS template');
assert.equal(path.resolve(repoRoot, 'port/src-tauri/app', nsisConfig.template), path.join(installerDir, 'installer-template.nsi'), 'the registered template path resolves from tauri.conf.json');
assert.equal(nsisConfig.installMode, 'currentUser', 'the pinned template retains current-user installation');
assert.deepEqual(nsisConfig.languages, ['SimpChinese', 'English'], 'the existing installer languages remain configured');
assert.equal(nsisConfig.displayLanguageSelector, true, 'the language selector remains enabled');
assert.equal(nsisConfig.startMenuFolder, 'DeepSeek Harness', 'the existing Start menu folder remains configured');
assert.equal(nsisConfig.installerHooks, '../../installer/installer-hooks.nsh', 'the existing hooks remain registered');
assert.deepEqual(nsisConfig.customLanguageFiles, { SimpChinese: '../../installer/installer-strings.nsh' }, 'the custom Chinese strings remain registered');

const template = await readFile(path.join(installerDir, 'installer-template.nsi'), 'utf8');
const provenance = JSON.parse(await readFile(path.join(installerDir, 'installer-template-provenance.json'), 'utf8'));
const templateHash = createHash('sha256').update(template.replace(/\r\n/g, '\n')).digest('hex');
assert.equal(provenance.tauriCliVersion, '2.11.5', 'the template pin records the reviewed Tauri CLI');
assert.equal(provenance.tauriBundlerVersion, '2.9.4', 'the template pin records the reviewed Tauri bundler');
assert.equal(provenance.tauriCliBundlerRequirement, 'tauri-cli 2.11.5 Cargo.toml pins tauri-bundler = 2.9.4', 'the provenance records the CLI-to-bundler pin');
assert.equal(provenance.upstreamTemplateSha256, '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079', 'the upstream template provenance is pinned');
assert.equal(provenance.repositoryTemplateSha256, templateHash, 'the vendored template matches its reviewed provenance hash');
assert.equal(execFileSync('cargo', ['tauri', '--version'], { encoding: 'utf8' }).trim(), `tauri-cli ${provenance.tauriCliVersion}`, 'a Tauri CLI version change forces template review');

const activeTemplate = template.split(/\r?\n/).filter((line) => !line.trimStart().startsWith(';')).join('\n');
assert.doesNotMatch(activeTemplate, /!insertmacro\s+CheckIfAppIsRunning/, 'install and uninstall do not reach Tauri’s name-based killer');
assert.doesNotMatch(activeTemplate, /KillProcessCurrentUser/, 'the active template contains no reachable stock kill call');
const sectionBody = (name) => {
  const start = activeTemplate.indexOf(`Section ${name}`);
  assert.notEqual(start, -1, `${name} section exists`);
  const bodyStart = activeTemplate.indexOf('\n', start) + 1;
  const end = activeTemplate.indexOf('SectionEnd', bodyStart);
  assert.notEqual(end, -1, `${name} section closes`);
  return activeTemplate.slice(bodyStart, end);
};
assert.ok(sectionBody('Install').includes('!insertmacro DSH_INSTALLER_GUARD_RUNNING_INSTANCE DshInstallerGuardRunningInstance'), 'the install section uses its non-killing second check');
assert.ok(sectionBody('Uninstall').includes('!insertmacro DSH_INSTALLER_GUARD_RUNNING_INSTANCE un.DshInstallerGuardRunningInstance'), 'the uninstall section uses its non-killing second check');
assert.match(activeTemplate, /DSH_INSTALLER_GUARD_RUNNING_INSTANCE/, 'both stock checks are replaced with the bounded port guard');
assert.match(template, /RequestExecutionLevel user/, 'the current-user execution level remains in the pinned template');
assert.match(template, /MUI_PAGE_DIRECTORY/, 'the custom destination page remains in the pinned template');
assert.match(template, /CreateOrUpdateStartMenuShortcut/, 'Start menu shortcut handling remains in the pinned template');
assert.match(template, /WriteRegStr SHCTX/, 'registry registration remains in the pinned template');
assert.match(template, /Function \.onInstSuccess/, 'Tauri silent/passive relaunch handling remains in the pinned template');
assert.match(template, /ExecWait '\$R1' \$0/, 'the existing upgrade path remains, including its old-uninstaller boundary');
assert.match(provenance.unsupportedUpgradeBoundary, /pre-existing uninstaller/i, 'the provenance record does not claim old installer bytes are repaired');
