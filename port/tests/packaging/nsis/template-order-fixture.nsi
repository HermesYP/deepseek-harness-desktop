Unicode true
; Pre-payload compile fixture for the registered template's ORDERING invariants.
;
; WHAT THIS FIXTURE IS FOR
;
; `installer-template.nsi` includes the registered hooks file, and the hooks pull
; in `installer-process.nsh`, which compiles real `Function`s that read
; `$UpdateMode` and reference the `nsis_tauri_utils` plugin. Three orderings
; therefore decide whether the generated installer compiles at all:
;
;   1. the `additional` plugin directory must be registered BEFORE the hooks
;      include, because the plugin call is compiled at the include's position;
;   2. that directory must be registered EXACTLY ONCE. Once a plugin command has
;      resolved `nsis_tauri_utils` out of it, a later `!addplugindir` that also
;      provides the plugin - including the identical path - makes the NEXT command
;      naming that plugin abort with `Plugin command
;      nsis_tauri_utils::SemverCompare conflicts with a plugin in another
;      directory!`. That is the real bundle failure this fixture pins, and
;      `DshFixtureSemverCompare` below is the command that reports it.
;   3. exactly ONE file may declare `Var PassiveMode` / `Var UpdateMode`, and the
;      declaration must be compiled before the first read of either name.
;
; This fixture reproduces the template's preamble in the SAME order and then
; compiles the ACTUAL, unmodified `installer-hooks.nsh` against it, with the real
; plugin present. `${DSH_FIXTURE_ORDER}` selects the arrangements that were tried
; and rejected, so each one's failure is reproduced rather than asserted:
;
;   fixed                    the repository template's arrangement: the signed
;                            directory (when supplied) and the additional
;                            directory registered once, above the hooks include,
;                            with `DSH_ADDITIONAL_PLUGINS_REGISTERED` set so the
;                            stock site below emits nothing. EXPECTED: makensis
;                            exit 0, no warning 6000, no "already declared", no
;                            "Plugin not found", no plugin conflict.
;   fixed-unsigned           the same, with NO signed directory supplied - the
;                            `can_sign() == false` rendering, where the additional
;                            path is the toolset's own instead of a copied tree.
;                            EXPECTED: exit 0 with the same clean log.
;   late-plugin              the additional directory is registered only at the
;                            stock site below (the original defect). EXPECTED:
;                            exit != 0 with "Plugin not found, cannot call
;                            nsis_tauri_utils::FindProcessCurrentUser".
;   duplicate-additional-dir the PRE-FIX template: the early registration exists
;                            but no sentinel is set, so the stock site registers
;                            the very same directory again after the hooks already
;                            resolved the plugin. EXPECTED: exit != 0 with
;                            "conflicts with a plugin in another directory" at
;                            `DshFixtureSemverCompare`. This is the arrangement
;                            that failed the real bundle.
;   duplicate-var            the Vars are declared only where the stock template
;                            declares them, AFTER the hooks include, while
;                            `installer-process.nsh` declares them too (no
;                            sentinel). EXPECTED: exit != 0 with
;                            `Error: variable "..." already declared`.
;   process-vars-removed     the sentinel is defined but NEITHER file declares the
;                            Vars before the hooks include: this is the naive
;                            "just delete the Var lines from installer-process.nsh"
;                            fix. EXPECTED: exit 0 BUT warning 6000
;                            "unknown variable/constant \"UpdateMode\"" - the name
;                            silently expands to nothing, so the guard's
;                            `If} $UpdateMode = 1` bounded-wait branch is compiled
;                            against an empty string and never runs. This is why
;                            the module keeps a guarded fallback declaration
;                            instead of having its two Vars deleted.
;
; MEASURED, with the real `nsis_tauri_utils.dll` copied into this shape: the
; duplicate is only fatal AFTER the plugin has been resolved once (registering the
; same directory twice before any plugin use is harmless), and re-registering a
; directory that does not itself hold the DLL is harmless. The trigger is the
; DLL-bearing directory, which is why the fix registers it once rather than
; registering something else.
;
; The fixture is compiled by `port/tests/packaging/nsis-hooks-compile.ps1`. It is
; never shipped and is NEVER EXECUTED; the compile is the whole test.
;
; NOT A FULL TEMPLATE RENDER. Copy, registry, shortcut and upgrade side effects
; are omitted on purpose: they need a real payload. What is reproduced is exactly
; the compile-time ordering the three defects depended on, plus the template's own
; guard macro so a section-level expansion of it is still compiled.

!ifndef DSH_FIXTURE_ORDER
  !define DSH_FIXTURE_ORDER "fixed"
!endif
!ifndef DSH_FIXTURE_HOOKS
  !error "DSH_FIXTURE_HOOKS must be defined to the port's installer-hooks.nsh"
!endif
!ifndef DSH_FIXTURE_STRINGS
  !error "DSH_FIXTURE_STRINGS must be defined to the port's installer-strings.nsh"
!endif
!ifndef DSH_FIXTURE_ADDITIONAL_PLUGINS_DIR
  !error "DSH_FIXTURE_ADDITIONAL_PLUGINS_DIR must be defined to the Tauri additional plugin folder"
!endif
!ifndef DSH_FIXTURE_OUT
  !error "DSH_FIXTURE_OUT must be defined to the compile output path"
!endif
!ifndef DSH_FIXTURE_UNINST
  !error "DSH_FIXTURE_UNINST must be defined to the uninstaller output path"
!endif

; ---------------------------------------------------------------------------
; Template position 1: plugin search paths, before every !include.
;
; `DSH_FIXTURE_SIGNED_PLUGINS_DIR` models `signed_plugins_path`: the copied
; `Plugins\x86-unicode` tree Tauri makes when `windows().can_sign()` is true. It
; is ABSENT when signing is off, which is the `fixed-unsigned` arrangement - and
; `{{#if signed_plugins_path}}` then emits nothing, so this block is skipped.
;
; `late-plugin` moves ONLY the additional-directory directive below the hooks
; include, which is the pre-fix generated installer's shape.
;
; `duplicate-additional-dir` registers it here but withholds the sentinel, so the
; stock site below registers the same directory a second time - the arrangement
; that failed the real bundle.
; ---------------------------------------------------------------------------
!ifdef DSH_FIXTURE_SIGNED_PLUGINS_DIR
  !addplugindir "${DSH_FIXTURE_SIGNED_PLUGINS_DIR}"
!endif
!if "${DSH_FIXTURE_ORDER}" != "late-plugin"
  !addplugindir "${DSH_FIXTURE_ADDITIONAL_PLUGINS_DIR}"
  !if "${DSH_FIXTURE_ORDER}" != "duplicate-additional-dir"
    !define DSH_ADDITIONAL_PLUGINS_REGISTERED
  !endif
!endif

; ---------------------------------------------------------------------------
; Template position 2: the template's include block.
; ---------------------------------------------------------------------------
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WordFunc.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

; ---------------------------------------------------------------------------
; Template position 3: the mode Vars and the sentinel, still ABOVE the hooks
; include. This is the block the repository template gained.
; ---------------------------------------------------------------------------
!if "${DSH_FIXTURE_ORDER}" == "duplicate-var"
  ; Nothing here, and no sentinel: `installer-process.nsh` emits its own fallback
  ; declarations at the hooks include, and the stock site below declares them a
  ; second time.
!else if "${DSH_FIXTURE_ORDER}" == "process-vars-removed"
  ; The naive fix: claim the template declared them, then declare them only
  ; further down, after the module that reads them is already compiled.
  !define DSH_TEMPLATE_MODE_VARS_DECLARED
!else
  ; fixed, fixed-unsigned, late-plugin and duplicate-additional-dir all use the
  ; repository template's arrangement for the mode Vars.
  !define DSH_TEMPLATE_MODE_VARS_DECLARED
  Var PassiveMode
  Var UpdateMode
!endif

; ---------------------------------------------------------------------------
; Template position 4: the ACTUAL registered hooks file, unmodified. It pulls in
; the REAL `installer-process.nsh`, including the real
; `nsis_tauri_utils::FindProcessCurrentUser` plugin call.
; ---------------------------------------------------------------------------
!include "${DSH_FIXTURE_HOOKS}"

; ---------------------------------------------------------------------------
; Template position 5: the template's own defines and its own Var block, which
; is where the stock template puts them: BELOW the hooks include.
; ---------------------------------------------------------------------------
!define MANUFACTURER "DeepSeek"
!define PRODUCTNAME "DeepSeek Harness"
!define VERSION "0.0.0-ordering-fixture"
!define VERSIONWITHBUILD "0.0.0.0"
!define BUNDLEID "ai.deepseek.harness.desktop"
!define INSTALLMODE "currentUser"
!define ARCH "x64"
!define ALLOWDOWNGRADES "true"
!define MAINBINARYNAME "dsh-desktop"
!define STARTMENUFOLDER "DeepSeek Harness"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"

!if "${DSH_FIXTURE_ORDER}" == "duplicate-var"
  ; The stock template's own declaration site. With no sentinel above,
  ; `installer-process.nsh` already declared both names at the hooks include, so
  ; this is the second declaration - the pre-fix template's actual failure.
  Var PassiveMode
  Var UpdateMode
!else if "${DSH_FIXTURE_ORDER}" == "process-vars-removed"
  ; The late declaration the naive fix relies on: correct for the template's own
  ; code below, too late for the module already compiled above.
  Var PassiveMode
  Var UpdateMode
!endif
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

; The stock template's own registration site (`!addplugindir
; "${ADDITIONALPLUGINSPATH}"`), reproduced with the repository template's guard.
;
; `late-plugin` skips the early registration entirely, so this line is the ONLY
; one - exactly the pre-fix generated installer, whose hooks include then cannot
; resolve the plugin at all.
;
; Every other arrangement registered the directory above and set
; `DSH_ADDITIONAL_PLUGINS_REGISTERED`, so this block emits nothing.
; `duplicate-additional-dir` deliberately withheld the sentinel, so the identical
; directory is registered a second time here - after the hooks include already
; resolved `nsis_tauri_utils` out of it - and `DshFixtureSemverCompare` below is
; the command that must then fail.
!ifndef DSH_ADDITIONAL_PLUGINS_REGISTERED
  !addplugindir "${DSH_FIXTURE_ADDITIONAL_PLUGINS_DIR}"
!endif

; The template's second non-killing check, byte-identical to the definition in
; `installer-template.nsi`; `nsis-hooks-compile.ps1` asserts that equality so the
; two cannot drift. The expansion below also proves `$dshInstallerError` - which
; `installer-process.nsh` declares at the hooks position - is still visible to a
; section-level macro inserted here.
!macro DSH_INSTALLER_GUARD_RUNNING_INSTANCE FUNCTION
  Call ${FUNCTION}
  ${If} $dshInstallerError != ""
    ${If} ${Silent}
      DetailPrint "$dshInstallerError"
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "$dshInstallerError" /SD IDOK
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

Name "${PRODUCTNAME}"
OutFile "${DSH_FIXTURE_OUT}"
InstallDir "$TEMP\dsh-template-order-fixture"
SilentInstall silent
RequestExecutionLevel user

!insertmacro MUI_RESERVEFILE_LANGDLL
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; Tauri includes the custom language files after `MUI_LANGUAGE`, which is the only
; position where `${LANG_*}` is defined.
!include "${DSH_FIXTURE_STRINGS}"

; The template's mode parser, reproduced so an OUTPUT-position write of both
; names is compiled at a position the template controls (`StrCpy
; $PassiveMode 1` is the shape that fails hard with `Usage: StrCpy
; $(user_var: output) ...` when the name is undeclared).
Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Function un.onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

; The template's own `nsis_tauri_utils::SemverCompare` call, reproduced from
; `installer-template.nsi`'s `PageReinstall` (`nsis_tauri_utils::SemverCompare
; "${VERSION}" $R0`).
;
; It is not decoration: it is the FIRST `nsis_tauri_utils` command compiled after
; the stock registration site, so it is the command whose name appears in
; `Plugin command nsis_tauri_utils::SemverCompare conflicts with a plugin in
; another directory!` - the real bundle failure. Without a call at this position
; the duplicate registration would be invisible to the compile.
Function DshFixtureSemverCompare
  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
FunctionEnd

Section Install
  ; Tauri invokes PREINSTALL before copying files, then its own stock check, then
  ; the port's registered second guard. Only the port's non-killing guard is
  ; reproduced; the stock killer is unreachable in the registered template.
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro DSH_INSTALLER_GUARD_RUNNING_INSTANCE DshInstallerGuardRunningInstance

  ; ...the template's File/WriteRegStr/shortcut work sits here and is omitted
  ; because it needs a real payload.

  !insertmacro NSIS_HOOK_POSTINSTALL

  ; The later nsis_tauri_utils use, after the stock registration site.
  Call DshFixtureSemverCompare

  ; Writing the uninstaller is what makes `Section Uninstall` real. Without it
  ; makensis warns 6020 and discards the uninstaller entirely, so the un. calls
  ; in NSIS_HOOK_PREUNINSTALL would never be resolved or compiled.
  WriteUninstaller "${DSH_FIXTURE_UNINST}"
SectionEnd

Section Uninstall
  !insertmacro NSIS_HOOK_PREUNINSTALL
  !insertmacro DSH_INSTALLER_GUARD_RUNNING_INSTANCE un.DshInstallerGuardRunningInstance
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
