Unicode true
; Compile-time integration fixture for the installer hooks.
;
; It reproduces the parts of Tauri's own `installer.nsi` (tauri-bundler 2.9.4,
; src/bundle/windows/nsis/installer.nsi) that the hooks depend on, in the SAME
; order, and then invokes every hook macro Tauri invokes:
;
;   line 22-32  MUI2 + FileFunc + LogicLib, and the string helper macros
;   line 34-36  !include "{{installer_hooks}}"   <- the port's hooks file
;   line 469-472 languages, then MUI_RESERVEFILE_LANGDLL
;   line 641-643 NSIS_HOOK_PREINSTALL   (install section, before files)
;   line 733-735 NSIS_HOOK_POSTINSTALL  (install section, after files)
;   line 778-780 NSIS_HOOK_PREUNINSTALL (uninstall section, before deletions)
;   line 886-888 NSIS_HOOK_POSTUNINSTALL
;
; The point is to prove the hooks compile in a Tauri-shaped script with the
; template's own variables and macros in scope -- a check that compiling the
; hooks alone cannot make, because the hooks reference ${MAINBINARYNAME},
; ${PRODUCTNAME}, $INSTDIR, $UpdateMode and $PassiveMode, none of which they
; define.
;
; This fixture is compiled by port/tests/packaging/nsis-hooks-compile.ps1. It is
; never shipped and never executed.

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

; nsis_tauri_utils is served from the NSIS toolset's `additional` folder, which
; Tauri's bundler adds (`additional_plugins_path` -> `!addplugindir
; "${ADDITIONALPLUGINSPATH}"` at installer.nsi:97). The fixture mirrors it.
!ifdef DSH_PLUGIN_DIR
  !addplugindir "${DSH_PLUGIN_DIR}"
!endif

; --- the registered hooks file, exactly where Tauri includes it -------------
!ifndef DSH_INSTALLER_HOOKS
  !error "DSH_INSTALLER_HOOKS must be defined to the port's installer-hooks.nsh"
!endif
!include "${DSH_INSTALLER_HOOKS}"

; --- defines Tauri supplies from the bundler's data map --------------------
!define PRODUCTNAME "DeepSeek Harness"
!define MAINBINARYNAME "dsh-desktop"
!define BUNDLEID "ai.deepseek.harness.desktop"
!define VERSION "0.0.0-test"
!define INSTALLMODE "currentUser"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\DeepSeek"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define STARTMENUFOLDER "DeepSeek Harness"

; The template's own Vars that the hooks read.
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
Var ReinstallPageCheck
Var AppStartMenuFolder

OutFile "${DSH_HOOKS_FIXTURE_OUT}"
!ifndef DSH_HOOKS_FIXTURE_UNINST
  ; The uninstaller path is asserted by the compile check, so it has a default
  ; rather than being optional.
  !define DSH_HOOKS_FIXTURE_UNINST "$TEMP\dsh-hooks-fixture-uninst.exe"
!endif
Name "${PRODUCTNAME}"
InstallDir "$TEMP\dsh-hooks-fixture"
SilentInstall silent
RequestExecutionLevel user

!insertmacro MUI_RESERVEFILE_LANGDLL
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; Tauri includes custom language files at installer.nsi:473-475, AFTER the
; MUI_LANGUAGE inserts, which is the only position where `${LANG_*}` is defined.
; That is where the port's translated messages belong, and this fixture
; reproduces that position.
;
; This is the SECOND include of the same file. The first happens indirectly: the
; hooks file at line 43 pulls in `installer-process.nsh`, which includes
; `installer-strings.nsh` to define its emit macro. That first include must NOT
; declare anything (no language exists yet at line 43), and this second one must -
; which is why the strings file keeps its macro definition and its declaration
; emission under separate guards. Both halves are load-bearing:
;
;   * without the first include, a caller can forget the messages and the guard
;     falls back to an English literal (the original defect);
;   * without this second include, nothing ever declares the LangStrings, so every
;     message warns 6040 and `$(...)` resolves to the EMPTY string - which the
;     guard reads as "nothing was wrong".
;
; `nsis-strings-messages.ps1` executes these messages per language, so a fixture
; that only compiled would not catch either failure.
!ifdef DSH_INSTALLER_STRINGS
  !include "${DSH_INSTALLER_STRINGS}"
!endif

Section Install
  ; Tauri calls PREINSTALL before copying files (installer.nsi:641-643).
  !insertmacro NSIS_HOOK_PREINSTALL

  ; ...the template's own CheckIfAppIsRunning and File/WriteRegStr calls sit
  ; here. They are omitted because they need a real payload.

  ; Tauri calls POSTINSTALL after files, registry and shortcuts (:733-735).
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd

; The uninstaller must actually be EMITTED, or the uninstall hooks are never
; compiled and the `Call un.<fn>` inside them is never resolved.
;
; MEASURED: without this, makensis reported
;   warning 6020: Uninstaller script code found but WriteUninstaller never used
;                 - no uninstaller will be created
; and DISCARDED the whole uninstaller, so `Section Uninstall` - including
; NSIS_HOOK_PREUNINSTALL and its `Call un.DshInstallerGuardRunningInstance` - was
; dead code that the compile check could not see. The suite passed while the
; port's uninstaller guard was untested. Writing the uninstaller is what makes the
; uninstall section real, and it is also what proves `Call un.<fn>` resolves
; against the module's install-side `Function <fn>`.
Section -InstallExtras
  WriteUninstaller "${DSH_HOOKS_FIXTURE_UNINST}"
SectionEnd

Section Uninstall
  !insertmacro NSIS_HOOK_PREUNINSTALL
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
