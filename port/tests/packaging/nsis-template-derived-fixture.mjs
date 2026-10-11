import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const phase = process.argv[2];
const evidenceRoot = process.argv[3] ? path.resolve(process.argv[3]) : '';
assert.ok(['red', 'green'].includes(phase), 'usage: node nsis-template-derived-fixture.mjs <red|green> <outside-root-evidence-dir>');
assert.ok(evidenceRoot && existsSync(evidenceRoot), 'the caller must supply an existing outside-root evidence directory');

const sourcePaths = [
  'port/installer/installer-template.nsi',
  'port/installer/installer-hooks.nsh',
  'port/installer/installer-process.nsh',
  'port/installer/installer-strings.nsh',
  'port/installer/installer-template-provenance.json',
  'port/src-tauri/app/tauri.conf.json',
  'port/tests/packaging/installer-contract.test.mjs',
  'port/tests/packaging/installer-regressions.test.mjs',
  'port/tests/packaging/nsis-template-derived-fixture.mjs',
];
const input = Object.fromEntries(sourcePaths.map((relative) => [relative, readFileSync(path.join(repoRoot, relative), 'utf8')]));
const config = JSON.parse(input['port/src-tauri/app/tauri.conf.json']);
assert.equal(config.bundle.windows.nsis.template, '../../installer/installer-template.nsi', 'fixture source must be the Tauri-registered repository template');
const templateRelative = path.relative(path.join(repoRoot, 'port/src-tauri/app'), path.join(repoRoot, config.bundle.windows.nsis.template));
assert.equal(templateRelative.split(path.sep).join('/'), 'port/installer/installer-template.nsi', 'registered template resolves to the source used by this fixture');

function sourceLines(relative) {
  return input[relative].split(/\r?\n/);
}
function findRange(lines, startIndex, endPredicate, label) {
  const end = lines.findIndex((line, index) => index >= startIndex && endPredicate(line));
  assert.ok(end >= startIndex, `${label} end marker exists`);
  return { text: lines.slice(startIndex, end + 1).join('\n'), startLine: startIndex + 1, endLine: end + 1 };
}
function extractFunction(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = name.startsWith('un.') ? '' : '';
  const match = source.match(new RegExp(`^Function ${prefix}${escaped}\\b([\\s\\S]*?)^FunctionEnd$`, 'm'));
  assert.ok(match, `template function ${name} exists`);
  const before = source.slice(0, match.index).split(/\r?\n/).length;
  return { text: match[0], startLine: before, endLine: before + match[0].split(/\r?\n/).length - 1 };
}
function extractSection(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `Section ${name}`);
  assert.ok(start >= 0, `template Section ${name} exists`);
  return findRange(lines, start, (line) => line.trim() === 'SectionEnd', `Section ${name}`);
}
function extractMacroDef(source, macroName) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `!macro ${macroName} FUNCTION`);
  assert.ok(start >= 0, `template macro ${macroName} exists`);
  return findRange(lines, start, (line) => line.trim() === '!macroend', `macro ${macroName}`);
}
function extractMacroInvocation(section, macroName, sectionName) {
  const lines = section.text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `!ifmacrodef ${macroName}`);
  assert.ok(start >= 0, `${sectionName} invokes ${macroName}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '!endif');
  assert.ok(end >= start, `${sectionName} closes ${macroName} conditional`);
  return { text: lines.slice(start, end + 1).join('\n'), startLine: section.startLine + start, endLine: section.startLine + end };
}
function extractGuardLine(section, call, sectionName) {
  const lines = section.text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === call);
  assert.ok(index >= 0, `${sectionName} contains the registered-template guard call`);
  return { text: lines[index], startLine: section.startLine + index, endLine: section.startLine + index };
}
function extractLine(section, pattern, label) {
  const lines = section.text.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  assert.ok(index >= 0, `${label} exists in the registered template`);
  return { text: lines[index], startLine: section.startLine + index, endLine: section.startLine + index };
}
function extractModeParser(source, functionName, lastMode) {
  const functionSource = extractFunction(source, functionName);
  const lines = functionSource.text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('GetOptions') && line.includes('"/P"'));
  assert.ok(start >= 0, `${functionName} parses /P`);
  const end = lines.findIndex((line, index) => index >= start && line.includes(`StrCpy $${lastMode} 1`));
  assert.ok(end >= 0, `${functionName} parses ${lastMode}`);
  const close = lines.findIndex((line, index) => index > end && line.trim() === '${EndIf}');
  assert.ok(close >= 0, `${functionName} mode parser closes`);
  return { text: lines.slice(start, close + 1).join('\n'), startLine: functionSource.startLine + start, endLine: functionSource.startLine + close };
}

const template = input['port/installer/installer-template.nsi'];
const installSection = extractSection(template, 'Install');
const uninstallSection = extractSection(template, 'Uninstall');
const sourceBlocks = {
  templateGuardMacro: extractMacroDef(template, 'DSH_INSTALLER_GUARD_RUNNING_INSTANCE'),
  installPreHook: extractMacroInvocation(installSection, 'NSIS_HOOK_PREINSTALL', 'Install'),
  installGuard: extractGuardLine(installSection, '!insertmacro DSH_INSTALLER_GUARD_RUNNING_INSTANCE DshInstallerGuardRunningInstance', 'Install'),
  installWriteUninstaller: extractLine(installSection, /WriteUninstaller /, 'WriteUninstaller'),
  installPostHook: extractMacroInvocation(installSection, 'NSIS_HOOK_POSTINSTALL', 'Install'),
  uninstallPreHook: extractMacroInvocation(uninstallSection, 'NSIS_HOOK_PREUNINSTALL', 'Uninstall'),
  uninstallGuard: extractGuardLine(uninstallSection, '!insertmacro DSH_INSTALLER_GUARD_RUNNING_INSTANCE un.DshInstallerGuardRunningInstance', 'Uninstall'),
  uninstallPostHook: extractMacroInvocation(uninstallSection, 'NSIS_HOOK_POSTUNINSTALL', 'Uninstall'),
  finishRunPage: (() => {
    const lines = template.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === '!define MUI_FINISHPAGE_RUN');
    assert.ok(start >= 0, 'template registers the finish-page Run checkbox');
    return findRange(lines, start, (line) => line.trim() === '!insertmacro MUI_PAGE_FINISH', 'finish page');
  })(),
  finishCallback: extractFunction(template, 'RunMainBinary'),
  installSuccessCallback: extractFunction(template, '.onInstSuccess'),
  installModeParser: extractModeParser(template, '.onInit', 'UpdateMode'),
  uninstallModeParser: extractModeParser(template, 'un.onInit', 'UpdateMode'),
  skipIfPassive: extractFunction(template, 'SkipIfPassive'),
};

const slotName = `${phase}-template-derived-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
const slot = path.join(evidenceRoot, slotName);
mkdirSync(slot, { recursive: false });
const sourceHashes = {};
for (const relative of sourcePaths) {
  const bytes = Buffer.from(input[relative], 'utf8');
  const destination = path.join(slot, 'source', relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: 'wx' });
  sourceHashes[relative] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const fixtureDir = path.join(slot, 'compile');
mkdirSync(fixtureDir, { recursive: false });
for (const relative of [
  'port/installer/installer-hooks.nsh',
  'port/installer/installer-strings.nsh',
]) {
  copyFileSync(path.join(repoRoot, relative), path.join(fixtureDir, path.basename(relative)));
}

let processModule = input['port/installer/installer-process.nsh'];
processModule = processModule.replace(
  'nsis_tauri_utils::FindProcessCurrentUser "${DSH_MAIN_BINARY_NAME}.exe"',
  'Call DshFixtureFindProcessCurrentUser',
);
processModule = processModule.replace(
  'nsis_tauri_utils::FindProcessCurrentUser "${DSH_MAIN_BINARY_NAME}.exe"',
  'Call un.DshFixtureFindProcessCurrentUser',
);
assert.equal((processModule.match(/nsis_tauri_utils::FindProcessCurrentUser/g) ?? []).length, 0, 'both observation calls are replaced by explicit deterministic fixture substitutes');
processModule = processModule.replace(/nsis_tauri_utils::RunAsUser[^\r\n]*/g, 'Call DshFixtureRunAsUser');
assert.equal((processModule.match(/nsis_tauri_utils::RunAsUser/g) ?? []).length, 0, 'the relaunch plugin is replaced with a count-only non-launching fixture substitute');
writeFileSync(path.join(fixtureDir, 'installer-process.nsh'), processModule, { flag: 'wx' });

const fragmentIndex = Object.fromEntries(Object.entries(sourceBlocks).map(([name, block]) => [name, {
  source: 'port/installer/installer-template.nsi',
  startLine: block.startLine,
  endLine: block.endLine,
  sha256: createHash('sha256').update(block.text).digest('hex'),
}]));
const compileSource = `; Template-derived no-install compile fixture.
; Extracted from the Tauri-registered installer-template.nsi; unrelated copy,
; registry, shortcut, and upgrade effects are intentionally omitted.
; The process-scan and RunAsUser plugin calls are deterministic substitutes.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
Name "DSH template-derived fixture (not a product installer)"
OutFile "${path.join(fixtureDir, 'dsh-template-derived-fixture.exe').replace(/\\/g, '/')}"
InstallDir "$EXEDIR/fixture-root"
RequestExecutionLevel user

!include "installer-hooks.nsh"

${sourceBlocks.templateGuardMacro.text}

Var dshFixtureMode
Var dshFixtureInstallScanCount
Var dshFixtureUninstallScanCount
Var dshFixtureLaunchCount

; Test-only observation substitute. The barrier modes return absent on the hook's
; first observation and present on the registered template's following guard.
; Missing modes return no stack value; malformed modes push a non-contract string.
Function DshFixtureFindProcessCurrentUser
  IntOp $dshFixtureInstallScanCount $dshFixtureInstallScanCount + 1
  \\$\{If} $dshFixtureMode == "missing-install"
    Return
  \\$\{ElseIf} $dshFixtureMode == "malformed-install"
    Push "00"
  \\$\{ElseIf} $dshFixtureMode == "install-barrier"
    \\$\{If} $dshFixtureInstallScanCount = 1
      Push "1"
    \\$\{Else}
      DetailPrint "DSH_FIXTURE_BARRIER install after first check"
      Push "0"
    \\$\{EndIf}
  \\$\{Else}
    Push "1"
  \\$\{EndIf}
FunctionEnd

Function un.DshFixtureFindProcessCurrentUser
  IntOp $dshFixtureUninstallScanCount $dshFixtureUninstallScanCount + 1
  \\$\{If} $dshFixtureMode == "missing-uninstall"
    Return
  \\$\{ElseIf} $dshFixtureMode == "malformed-uninstall"
    Push "00"
  \\$\{ElseIf} $dshFixtureMode == "uninstall-barrier"
    \\$\{If} $dshFixtureUninstallScanCount = 1
      Push "1"
    \\$\{Else}
      DetailPrint "DSH_FIXTURE_BARRIER uninstall after first check"
      Push "0"
    \\$\{EndIf}
  \\$\{Else}
    Push "1"
  \\$\{EndIf}
FunctionEnd

Function DshFixtureRunAsUser
  IntOp $dshFixtureLaunchCount $dshFixtureLaunchCount + 1
  DetailPrint "DSH_FIXTURE_RELAUNCH_COUNT=$dshFixtureLaunchCount"
  Push 0
FunctionEnd

Function .onInit
${sourceBlocks.installModeParser.text}
  \\$\{GetOptions} $CMDLINE "/FIXTURE" $dshFixtureMode
  \\$\{IfNot} \\$\{Errors}
    StrCpy $0 $dshFixtureMode 1
    \\$\{If} $0 == "="
      StrCpy $dshFixtureMode $dshFixtureMode "" 1
    \\$\{EndIf}
  \\$\{EndIf}
FunctionEnd

Function un.onInit
${sourceBlocks.uninstallModeParser.text}
  \\$\{GetOptions} $CMDLINE "/FIXTURE" $dshFixtureMode
  \\$\{IfNot} \\$\{Errors}
    StrCpy $0 $dshFixtureMode 1
    \\$\{If} $0 == "="
      StrCpy $dshFixtureMode $dshFixtureMode "" 1
    \\$\{EndIf}
  \\$\{EndIf}
FunctionEnd

${sourceBlocks.finishRunPage.text}

Function SkipIfPassive
${sourceBlocks.skipIfPassive.text.split(/\\r?\\n/).slice(1, -1).join('\\n')}
FunctionEnd

${sourceBlocks.finishCallback.text}
${sourceBlocks.installSuccessCallback.text}

Section Install
  SetOutPath $INSTDIR
${sourceBlocks.installPreHook.text}
${sourceBlocks.installGuard.text}
${sourceBlocks.installWriteUninstaller.text}
${sourceBlocks.installPostHook.text}
SectionEnd

Section Uninstall
${sourceBlocks.uninstallPreHook.text}
${sourceBlocks.uninstallGuard.text}
${sourceBlocks.uninstallPostHook.text}
SectionEnd

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!include "installer-strings.nsh"
`;
const fixtureSourcePath = path.join(fixtureDir, 'installer-template-derived-fixture.nsi');
writeFileSync(fixtureSourcePath, compileSource, { flag: 'wx' });
writeFileSync(path.join(slot, 'fragment-index.json'), `${JSON.stringify({ classification: 'Tauri-registered-template-derived control-flow extraction; not a full Tauri Handlebars render or shipped installer', fragments: fragmentIndex }, null, 2)}\n`, { flag: 'wx' });

const testRun = spawnSync(process.execPath, ['--test', path.join(repoRoot, 'port/tests/packaging/installer-regressions.test.mjs')], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const testOutput = `${testRun.stdout ?? ''}${testRun.stderr ?? ''}`;
writeFileSync(path.join(slot, `${phase}-test.output.txt`), testOutput, { flag: 'wx' });
const expectedTestOutcome = phase === 'red' ? testRun.status !== 0 : testRun.status === 0;
const makensis = process.env.MAKENSIS_EXE || path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe');
assert.ok(makensis && existsSync(makensis), `makensis prerequisite missing; set MAKENSIS_EXE to an attested outside-root binary (${makensis})`);
const makensisBytes = readFileSync(makensis);
const makensisSha256 = createHash('sha256').update(makensisBytes).digest('hex');
const compileLogPath = path.join(slot, 'compile.output.txt');
const compileRun = spawnSync(makensis, ['/V2', `/O${compileLogPath}`, fixtureSourcePath], { cwd: fixtureDir, encoding: 'utf8', windowsHide: true });
writeFileSync(path.join(slot, 'compile.stdout.txt'), compileRun.stdout ?? '', { flag: 'wx' });
writeFileSync(path.join(slot, 'compile.stderr.txt'), compileRun.stderr ?? '', { flag: 'wx' });
const compileLog = existsSync(compileLogPath) ? readFileSync(compileLogPath, 'utf8') : '';
const fixtureExe = path.join(fixtureDir, 'dsh-template-derived-fixture.exe');
const fixtureExeExists = existsSync(fixtureExe);
const noSuppressedUninstaller = !/warning\s+6020|uninstaller section was discarded/i.test(compileLog);
const noUnresolvedUninstall = !/resolving uninstall function|uninstall function .* not found/i.test(compileLog);
const receipt = {
  schemaVersion: 1,
  phase: phase.toUpperCase(),
  createdUtc: new Date().toISOString(),
  sourceRoot: repoRoot,
  baseline: 'bd4641e1c58928add9f0adddf5e9afe8fbd201ea',
  fixtureClassification: 'Tauri-registered-template-derived control-flow extraction; not a full Tauri render or shipped installer',
  noInstallScope: 'compile only; installer fixture, app, Host, SDK, and stand-ins were not launched',
  sourceHashes,
  generatedFixture: {
    path: fixtureSourcePath,
    sha256: createHash('sha256').update(readFileSync(fixtureSourcePath)).digest('hex'),
    bytes: readFileSync(fixtureSourcePath).length,
    fragmentIndex: path.join(slot, 'fragment-index.json'),
  },
  compiler: { path: makensis, sha256: makensisSha256, bytes: makensisBytes.length },
  substitutes: [
    'FindProcessCurrentUser -> deterministic install/uninstall observation functions with missing, malformed, and second-check barrier modes',
    'RunAsUser -> count-only function; relaunch log exposes no session material and starts no program',
    'Tauri template file/registry/shortcut/upgrade side effects omitted; real registered-template guard and finish callback source fragments retained',
  ],
  redGreenTest: { exitCode: testRun.status, signal: testRun.signal ?? null, expectedOutcome: expectedTestOutcome, output: path.join(slot, `${phase}-test.output.txt`) },
  compile: {
    exitCode: compileRun.status,
    signal: compileRun.signal ?? null,
    output: compileLogPath,
    stdout: path.join(slot, 'compile.stdout.txt'),
    stderr: path.join(slot, 'compile.stderr.txt'),
    fixtureExe: fixtureExeExists ? fixtureExe : null,
    fixtureExeSha256: fixtureExeExists ? createHash('sha256').update(readFileSync(fixtureExe)).digest('hex') : null,
    fixtureExeBytes: fixtureExeExists ? readFileSync(fixtureExe).length : null,
    noSuppressedUninstaller,
    noUnresolvedUninstall,
  },
};
writeFileSync(path.join(slot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ slot, phase: receipt.phase, testExitCode: testRun.status, compileExitCode: compileRun.status, fixtureExe: receipt.compile.fixtureExe, fixtureExeSha256: receipt.compile.fixtureExeSha256, noSuppressedUninstaller, noUnresolvedUninstall }, null, 2));
if (!expectedTestOutcome || compileRun.status !== 0 || !fixtureExeExists || !noSuppressedUninstaller || !noUnresolvedUninstall) process.exitCode = 1;
