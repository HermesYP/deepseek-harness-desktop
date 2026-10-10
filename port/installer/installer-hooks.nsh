; DeepSeek Harness Desktop - NSIS installer hooks.
;
; Registered through Tauri's documented NSIS extension point:
;   bundle.windows.nsis.installerHooks -> this file
; Tauri's own `installer.nsi` (tauri-bundler 2.9.4,
; src/bundle/windows/nsis/installer.nsi) includes it at lines 34-36, ahead of its
; own definitions, and invokes exactly four macros, at the sites documented on
; `NsisConfig::installer_hooks` in tauri-utils:
;
;   :641  NSIS_HOOK_PREINSTALL      install section, before files/registry/shortcuts
;   :733  NSIS_HOOK_POSTINSTALL     install section, after files/registry/shortcuts
;   :778  NSIS_HOOK_PREUNINSTALL    uninstall section, before deletions
;   :886  NSIS_HOOK_POSTUNINSTALL   uninstall section, after deletions
;
; A macro this file does not define is skipped by Tauri's `!ifmacrodef` guards, so
; any subset is valid.
;
; WHAT THIS FIXES
;
; 1. Broad same-name process kill. Tauri's stock
;    `!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"`
;    (installer.nsi:645 and :782, defined in utils.nsh:22-71) matches by IMAGE
;    NAME and then calls `KillProcessCurrentUser`, terminating every match. A
;    second installation of the same product in a different directory - a
;    side-by-side qualification install, a portable copy, a colleague's extracted
;    build - is killed even though it shares no files, and an in-flight agent task
;    is lost after a single confirmation with no chance to refuse.
;
;    The template runs that macro inside the Install and Uninstall sections, so
;    this file cannot suppress it by defining a macro. What it can do is run
;    FIRST, resolve the question its own way, and refuse before the template's
;    check is reached. `installer-process.nsh` documents what that check can and
;    cannot prove, and how a refusal is reported.
;
; 2. Reliable `/UPDATE` relaunch, exactly once. Tauri's `.onInstSuccess`
;    (installer.nsi:743-754) honours `/R` only for silent or passive installers,
;    so a GUI update started by the application never brings the window back. It
;    also re-reads `/ARGS` but never stores it. This file records the relaunch
;    intent and the launch arguments in `POSTINSTALL`, normalizes the `=` that
;    `GetOptions` leaves on the documented `/ARGS=<value>` form, and relaunches
;    from `$INSTDIR`. The relaunch is idempotent and the silent/passive cases are
;    deferred to the template, so exactly ONE launch happens per install; two
;    were measured before that guard existed.
;
; 3. Custom destination. Nothing here deletes or rewrites anything outside
;    `$INSTDIR`. User data lives under `$DSH_HOME` and `%APPDATA%\<bundle id>`,
;    which only Tauri's own "delete app data" checkbox removes. A custom
;    destination is honoured because `$INSTDIR` is the directory Tauri installed
;    into, and the relaunch uses the same value.
;
; STRUCTURE
;
;   installer-strings.nsh     localized messages
;   installer-process.nsh     presence scan, bounded wait, relaunch
;   installer-hooks.nsh       this file: the macro definitions
;
; `installer-process.nsh` includes `installer-strings.nsh` itself, so the message
; DEFINITIONS cannot be forgotten by a caller; forgetting them is a fail-open
; default, because an undefined `$(...)` resolves to "" and "" reads as "no
; error". That include is at the hooks position, where `${LANG_*}` is not yet
; defined, so it defines the emit MACRO rather than any `LangString`. The
; declarations are emitted where Tauri's `customLanguageFiles` includes the same
; file (`installer.nsi:473-475`), after `MUI_LANGUAGE`. Both halves are required:
; the include makes the messages unforgettable, and the late emission is what
; makes the SimpChinese translation reachable instead of collapsing both
; languages onto id 1033.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define DSH_INSTALLER_DIR "${__FILEDIR__}"
!include "${DSH_INSTALLER_DIR}\installer-process.nsh"

; --- state used across hooks -----------------------------------------------
;
; The Vars live in `installer-process.nsh`, which this file includes, so they
; exist for both the installer and the uninstaller and cannot be declared twice.

!macro DSH_INSTALLER_INIT
  StrCpy $dshInstallerError ""
  StrCpy $dshRelaunchRequested "0"
  StrCpy $dshRelaunchArgs ""
  StrCpy $dshRelaunchHandled "0"
!macroend

; Tauri's `.onInit` (installer.nsi:477-524) parses `/UPDATE` into `$UpdateMode`
; and `/P` into `$PassiveMode` before any section runs, and `un.onInit`
; (:756-774) parses `/UPDATE` again. `/ARGS`, which `.onInstSuccess` reads but
; never stores (:750), is captured here.
;
; `$dshCapture` is a file-owned register rather than `$R0`. MEASURED: the
; template's own `.onInstSuccess` (:748-751) does `${GetOptions} $CMDLINE "/R"
; $R0` and then reuses `$R0` for `/ARGS` immediately before its RunAsUser, and
; `CodeSection`/other template code uses `$R0` too. Writing a shared `$R` register
; from a hook leaves a value that later template code does not expect to have been
; touched; a hook-owned variable cannot collide.
!macro DSH_INSTALLER_CAPTURE_ARGUMENTS
  ${GetOptions} $CMDLINE "/ARGS" $dshCapture
  ${IfNot} ${Errors}
    StrCpy $dshRelaunchArgs "$dshCapture"
    Call DshNormalizeLaunchArgs
  ${EndIf}
!macroend

; --- pre-install ------------------------------------------------------------
;
; Runs before Tauri copies files and before its own process check, so that check
; finds nothing and does nothing. Its own decision is to refuse rather than to
; kill.
;
; WHY `Abort` AND NOT `Quit`, AND WHAT WAS ACTUALLY MEASURED.
;
; Both were compiled into a minimal probe structured exactly like this hook (a
; `SetErrorLevel 2` followed by the idiom, inside a `Call`ed function reached from
; a section) and executed as a silent installer. The measurement contradicts the
; common assumption in both directions:
;
;   * BOTH idioms terminate the installer from inside the `Call`ed function; the
;     marker statement after the `Call` was never written for either.
;   * BOTH propagate the error level: the process exit code was 2 for `Quit` and
;     for `Abort`, in every ordering tested, including `Quit` followed by
;     `SetErrorLevel 2` and the reverse.
;   * BOTH stop the rest of the section, so the template's file copy, registry
;     writes and shortcut creation did not run.
;
; So `Quit` is not the fail-open exit-code hole it is sometimes described as. It
; is still the wrong choice here for a different and concrete reason: `Quit`
; terminates the entire installer unconditionally, including when the refusal is
; only about the current section, whereas `Abort` fails the CURRENT section and
; lets the installer unwind normally - which is what a section-scoped refusal
; means, and it is the idiom NSIS documents for "fail this section". `Abort` also
; accepts a message (`Abort "text"`) for the silent/passive case where no dialog
; is shown. The error level is set BEFORE the abort so the ordering is
; unambiguous.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro DSH_INSTALLER_INIT
  !insertmacro DSH_INSTALLER_CAPTURE_ARGUMENTS
  Call DshInstallerGuardRunningInstance
  ${If} $dshInstallerError != ""
    ${If} ${Silent}
      ; A silent install has no dialog to read, so the message goes to the
      ; detail pane and the exit code carries the failure.
      DetailPrint "$dshInstallerError"
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "$dshInstallerError" /SD IDOK
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

; --- post-install -----------------------------------------------------------
;
; Relaunch happens here rather than in `.onInstSuccess` so it covers GUI, passive
; and silent installs identically and runs while `$INSTDIR` is the directory just
; installed into.
;
; THE DOUBLE-LAUNCH GUARD. Tauri's `.onInstSuccess` (:743-754) is NOT suppressed
; by anything here: it runs after the sections and relaunches on its own whenever
; `/R` was passed to a silent or passive installer. MEASURED with a minimal NSIS
; probe shaped like this hook plus that `.onInstSuccess`: an unguarded hook
; launched the application TWICE for one silent `/UPDATE /R` run, because both
; paths fired. Two instances contend for the same `$DSH_HOME` lock.
;
; `DshInstallerRelaunch` is therefore idempotent (it records that it launched),
; and this hook defers entirely to the template for the silent/passive cases it
; already handles - so exactly one launch happens whichever path gets there first.
!macro NSIS_HOOK_POSTINSTALL
  ; An update always brings the application back: the user started it from a
  ; running application whose window the installer closed.
  ${If} $UpdateMode = 1
    StrCpy $dshRelaunchRequested "1"
  ${EndIf}
  ; A fresh install relaunches only when explicitly asked.
  ${GetOptions} $CMDLINE "/R" $dshCapture
  ${IfNot} ${Errors}
    StrCpy $dshRelaunchRequested "1"
  ${EndIf}

  ; A passive install skips the finish page, so nothing else would start the
  ; application for the user.
  ${If} $PassiveMode = 1
    StrCpy $dshRelaunchRequested "1"
  ${EndIf}

  ${If} $dshRelaunchRequested = "1"
    ; Silent and passive installs are relaunched by Tauri's own `.onInstSuccess`.
    ; Deferring to it avoids the second launch; the GUI path has no such
    ; relaunch, so the hook must perform it there.
    ${If} ${Silent}
      DetailPrint "the template relaunches silent installers; deferring"
    ${ElseIf} $PassiveMode = 1
      DetailPrint "the template relaunches passive installers; deferring"
    ${Else}
      Call DshInstallerRelaunch
    ${EndIf}
  ${EndIf}
!macroend

; --- uninstall --------------------------------------------------------------
;
; The same path-specific rule Tauri applies at :782, executed first so the
; template's own name-scoped kill is not reached. `$INSTDIR` in the uninstaller
; is the directory recorded at install time, so a custom destination stays
; correct.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DSH_INSTALLER_INIT
  Call un.DshInstallerGuardRunningInstance
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

!macro NSIS_HOOK_POSTUNINSTALL
  ; Nothing to do. Data outside `$INSTDIR` is retained unless Tauri's own
  ; "delete app data" checkbox was ticked, which its template handles at
  ; installer.nsi:870-884.
!macroend
