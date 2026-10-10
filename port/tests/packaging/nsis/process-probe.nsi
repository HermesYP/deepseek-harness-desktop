Unicode true
; Runtime qualification fixture for installer-process.nsh.
;
; It compiles the port's guard into a standalone program and reports, for a
; supplied target directory, whether the guard would allow installation. Running
; it proves the parts a syntax-only compile cannot: that the pinned
; `nsis_tauri_utils` name scan is called correctly, that its stack-based return
; convention matches, and that the bounded update wait terminates.
;
; The fixture deliberately does NOT kill anything and does NOT install: it only
; reports the guard's decision, which is the behaviour under test.
;
; Usage: dsh-installer-guard-probe.exe /TARGETDIR <dir> /MODENAME <fresh|update>
;                                     /REPORT <file>

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "MUI2.nsh"

; ORDER MATTERS, and getting it wrong produces a false PASS rather than a
; compile error: a `LangString` must be DEFINED before the `MUI_LANGUAGE` insert
; that activates it. If the insert comes first, `$(DSH_INSTALLER_RUNNING)`
; resolves to the empty string at run time, the guard sets an empty error, and
; the probe reads that as "allowed" while an instance is demonstrably running.
; This is the same ordering Tauri's own `installer.nsi` has: it includes the
; registered hooks file at line 34-36 and inserts its languages at line 469-471,
; so the hook's LangStrings are already defined when the inserts run.
;
; The languages match `tauri.conf.json` `bundle.windows.nsis.languages`.

!ifndef DSH_PROBE_OUT
  !define DSH_PROBE_OUT "..\..\..\.scratch\nsis-probe\dsh-installer-guard-probe.exe"
!endif
; Tauri's bundler makes nsis_tauri_utils available by adding the NSIS toolset's
; `additional` plugin folder (tauri-bundler mod.rs adds it via
; `additional_plugins_path`, and installer.nsi applies
; `!addplugindir "${ADDITIONALPLUGINSPATH}"`). The probe mirrors that, and the
; path is passed in so the fixture does not depend on `$LOCALAPPDATA` being
; expandable at compile time.
!ifdef DSH_PLUGIN_DIR
  !addplugindir "${DSH_PLUGIN_DIR}"
!endif

OutFile "${DSH_PROBE_OUT}"
Name "dsh-installer-guard-probe"
InstallDir "$TEMP\dsh-installer-guard-probe"
SilentInstall silent
; NSIS defaults to requireAdministrator, which makes this fixture wait on a UAC
; prompt and never terminate in an unelevated test run. The guard needs no
; privilege: the plugin's FindProcessCurrentUser and its peers are per-user by
; construction.
RequestExecutionLevel user

!define MAINBINARYNAME "dsh-desktop"

; The probe's own state. The guard's Vars (including `UpdateMode`, which Tauri's
; template also declares) come from `installer-process.nsh`; declaring them here
; as well is a makensis error, "variable already declared".
Var fh
Var dshTargetDir
Var dshReportPath
Var dshModeName

!include "${DSH_INSTALLER_DIR}\installer-process.nsh"

; After the module, so the LangStrings it references are already defined, and
; with the same reserved-language-dialog macro Tauri's template uses
; (installer.nsi:472 `!insertmacro MUI_RESERVEFILE_LANGDLL`). Without it,
; makensis leaves the additional languages out of the string table and warns
; 6040, which is how this ordering mistake becomes visible.
;
; ORDER, AND WHY THE STRINGS INCLUDE COMES AFTER THE LANGUAGES.
;
; This fixture reproduces Tauri's `installer.nsi`, where `MUI_LANGUAGE` inserts at
; line 469-471 come BEFORE the custom language files at line 473-475. A LangString
; declared before `${LANG_*}` exists is misattributed to language id 1033 and
; warning 7025 - and, worse, `$(NAME)` for a string that was never declared
; resolves to the EMPTY string, which the guard reads as "nothing was wrong".
;
; `installer-process.nsh` includes `installer-strings.nsh` itself (at the hooks
; position, before any language), so the macros are defined by the time this file
; is reached; that early include deliberately declares nothing. The include below
; is the one that EMITS the declarations, and it must follow MUI_LANGUAGE.
!insertmacro MUI_RESERVEFILE_LANGDLL
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

!ifdef DSH_INSTALLER_STRINGS
  !include "${DSH_INSTALLER_STRINGS}"
!endif

Section
  ${GetParameters} $R0
  ${GetOptions} $R0 "/TARGETDIR" $dshTargetDir
  ${GetOptions} $R0 "/REPORT" $dshReportPath
  ${GetOptions} $R0 "/MODENAME" $dshModeName
  ${If} $dshTargetDir == ""
  ${OrIf} $dshReportPath == ""
    SetErrorLevel 3
    Quit
  ${EndIf}

  StrCpy $INSTDIR $dshTargetDir
  ; `/UPDATE` is what Tauri's own .onInit turns into $UpdateMode; the probe sets
  ; the same variable directly so both branches are reachable without compiling
  ; a second installer.
  ${If} $dshModeName == "update"
    StrCpy $UpdateMode 1
  ${Else}
    StrCpy $UpdateMode 0
  ${EndIf}

  Call DshInstallerGuardRunningInstance

  FileOpen $fh "$dshReportPath" w
  FileWrite $fh "PROBE-MODE=$dshModeName$\r$\n"
  FileWrite $fh "PROBE-ERROR-RAW=[$dshInstallerError]$\r$\n"
  ${If} $dshInstallerError == ""
    FileWrite $fh "PROBE-DECISION=allow$\r$\n"
  ${Else}
    FileWrite $fh "PROBE-DECISION=refuse$\r$\n"
  ${EndIf}
  FileWrite $fh "PROBE-NAME-RUNNING=$dshNameRunningCount$\r$\n"
  FileClose $fh

  SetErrorLevel 0
SectionEnd
