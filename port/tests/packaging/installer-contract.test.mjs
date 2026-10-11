import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const installerDir = path.join(repoRoot, 'port/installer');
const readInstaller = (name) => readFile(path.join(installerDir, name), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The record this suite enforces. It is read once, so every test below checks the
// same reviewed values.
const provenance = JSON.parse(await readInstaller('installer-template-provenance.json'));
const template = await readInstaller('installer-template.nsi');
const templateHash = sha256(template.replace(/\r\n/g, '\n'));
const config = JSON.parse(await readFile(path.join(repoRoot, 'port/src-tauri/app/tauri.conf.json'), 'utf8'));

// The installed Cargo package manifests are this record's provenance source, so
// no bare `cargo` resolved from PATH decides which CLI version the template is
// checked against. The registry source tree holds the installed crates' own
// normalized manifests; hashing those exact bytes binds the record to the
// metadata that was actually installed, and a CLI or bundler version change
// moves the directory name (and so the hash), which forces a template review.
async function installedPackageManifest(name, version) {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const registryRoot = path.join(cargoHome, 'registry', 'src');
  const indexes = (await readdir(registryRoot).catch(() => [])).sort();
  for (const index of indexes) {
    const candidate = path.join(registryRoot, index, `${name}-${version}`, 'Cargo.toml');
    if (existsSync(candidate)) {
      const bytes = await readFile(candidate);
      return { path: candidate, bytes, text: bytes.toString('utf8') };
    }
  }
  assert.fail(`the installed ${name} ${version} package manifest was not found under ${registryRoot}`);
}

// This suite reads the real production helper and its call site; it does not
// build an unrelated test argument list or launch a process stand-in.
test('the installed Tauri CLI and bundler manifests match the recorded provenance', async () => {
  const cli = await installedPackageManifest('tauri-cli', provenance.tauriCliVersion);
  const bundler = await installedPackageManifest('tauri-bundler', provenance.tauriBundlerVersion);
  assert.equal(sha256(cli.bytes), provenance.tauriCliPackageManifestSha256, 'the installed CLI package metadata is the recorded one');
  assert.equal(sha256(bundler.bytes), provenance.tauriBundlerPackageManifestSha256, 'the installed bundler package metadata is the recorded one');
  assert.match(cli.text, /^name = "tauri-cli"$/m, 'the recorded CLI manifest is the tauri-cli package');
  assert.match(bundler.text, /^name = "tauri-bundler"$/m, 'the recorded bundler manifest is the tauri-bundler package');
  const pin = cli.text.match(/\[dependencies\.tauri-bundler\]\r?\nversion = "([^"]+)"/);
  assert.ok(pin, 'the installed CLI manifest still declares its tauri-bundler dependency');
  assert.equal(pin[1], provenance.tauriBundlerVersion, 'the installed CLI pins the recorded bundler, so a CLI change forces template review');
});

test('the vendored template matches its reviewed provenance hash', () => {
  assert.equal(provenance.repositoryTemplateSha256, templateHash, 'the vendored template matches its reviewed provenance hash');
});

test('Tauri registers the repository-owned template and keeps the pinned installer settings', () => {
  const nsisConfig = config.bundle.windows.nsis;
  assert.equal(nsisConfig.template, '../../installer/installer-template.nsi', 'Tauri registers the repository-owned NSIS template');
  assert.equal(path.resolve(repoRoot, 'port/src-tauri/app', nsisConfig.template), path.join(installerDir, 'installer-template.nsi'), 'the registered template path resolves from tauri.conf.json');
  assert.equal(nsisConfig.installMode, 'currentUser', 'the pinned template retains current-user installation');
  assert.deepEqual(nsisConfig.languages, ['SimpChinese', 'English'], 'the existing installer languages remain configured');
  assert.equal(nsisConfig.displayLanguageSelector, true, 'the language selector remains enabled');
  assert.equal(nsisConfig.startMenuFolder, 'DeepSeek Harness', 'the existing Start menu folder remains configured');
  assert.equal(nsisConfig.installerHooks, '../../installer/installer-hooks.nsh', 'the existing hooks remain registered');
  assert.deepEqual(nsisConfig.customLanguageFiles, { SimpChinese: '../../installer/installer-strings.nsh' }, 'the custom Chinese strings remain registered');
});

test('the active template reaches no stock process killer and uses the port guard in both sections', () => {
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
});

test('the vendored template keeps the pinned upstream behaviour', () => {
  assert.match(template, /RequestExecutionLevel user/, 'the current-user execution level remains in the pinned template');
  assert.match(template, /MUI_PAGE_DIRECTORY/, 'the custom destination page remains in the pinned template');
  assert.match(template, /CreateOrUpdateStartMenuShortcut/, 'Start menu shortcut handling remains in the pinned template');
  assert.match(template, /WriteRegStr SHCTX/, 'registry registration remains in the pinned template');
  assert.match(template, /Function \.onInstSuccess/, 'Tauri silent/passive relaunch handling remains in the pinned template');
  assert.match(template, /ExecWait '\$R1' \$0/, 'the existing upgrade path remains, including its old-uninstaller boundary');
});

test('the provenance record does not credit the new guards with protecting historical uninstaller bytes', () => {
  assert.match(provenance.unsupportedUpgradeBoundary, /pre-existing uninstaller/i, 'the provenance record does not claim old installer bytes are repaired');
  assert.match(provenance.unsupportedUpgradeBoundary, /new template.*(?:does not|cannot).*protect|guards?.*(?:do not|cannot).*protect/i, 'the new guards are not credited with protecting previously installed bytes');
});
