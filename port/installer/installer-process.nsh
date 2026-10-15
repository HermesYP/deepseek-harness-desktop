; Conservative name-based running-instance detection for the Desktop installer.
;
; WHY THIS EXISTS
;
; Tauri's upstream stock template invokes `CheckIfAppIsRunning` (tauri-bundler
; 2.9.4 utils.nsh:22-71), which calls `nsis_tauri_utils::KillProcessCurrentUser`
; and terminates same-name processes. The repository-owned template removes both
; invocations and uses this bounded refusal guard instead. Because this plugin
; only observes by image name, another installation of the same product in a
; different directory is conservatively refused too; no process is terminated.
;
; Upstream solves this in a compiled plugin
; (`_upstream/apps/desktop/installer/window-frame.cpp:56-84`,
; `InstallerFindProcess`) that compares a process's full image path. Adding a
; compiled DLL here would mean a new toolchain dependency and a new binary
; artifact, so this file uses only the pinned `nsis_tauri_utils` plugin.
;
; WHAT WAS MEASURED, NSIS 3.11 on this host
;
;   * `nsis_tauri_utils::FindProcessCurrentUser` works and is fast: it returned 0
;     for a live matching process and 1 when none matched, consistently across
;     repeated calls. It is the only process API the pinned plugin exports
;     (FindProcess, FindProcessCurrentUser, KillProcess, KillProcessCurrentUser,
;     RunAsUser, SemverCompare, StrReplace) and all four process functions are
;     name-scoped, which is exactly the granularity this question is asked at.
;   * `RunAsUser` returns 0 on success, on the plugin stack.
;   * NSIS plugin results are PUSHED; the caller must `Pop`.
;   * The `System` plugin cannot marshal a `PROCESSENTRY32W` out-structure:
;     `Process32FirstW` returns 0 with ERROR_INVALID_PARAMETER (80) for every
;     buffer layout and dwSize tried. A full-image-path comparison is therefore
;     NOT reproducible from an NSIS script here, so this file does not attempt
;     one. The consequence is stated below and in the lane report.
;
; WHAT THIS FILE DOES, AND ITS LIMIT
;
;   * update (`/UPDATE`, set by Tauri's own `.onInit`, installer.nsi:488-491):
;     wait, bounded, for the application to exit, then refuse if it has not.
;   * fresh install and uninstall: refuse immediately.
;
; It never kills a process. A refusal is recoverable and tells the user what to
; do; killing by image name can terminate an unrelated installation's work.
;
; THE LIMIT, STATED PLAINLY: presence is established by image name and the guard
; cannot prove the running process belongs to `$INSTDIR`. A same-named process in
; a DIFFERENT directory therefore also causes a refusal. This conservative
; side-by-side refusal is intentional for this milestone; a path-aware native
; helper is a separate enhancement.
;
; THE SECOND CHECK NARROWS THE WINDOW BUT CANNOT CLOSE IT. The pre-install hook
; and the registered template's later check are two separate observations of a
; non-atomic fact, so a same-name process can still appear after the final check
; and the installation proceeds. They are not an atomic installation lease, and
; nothing in this tree describes them as one.
;
; STRUCTURE
;
; Every decision is a flat `If`/`Else` over Vars with a single assignment site,
; and NO LogicLib block nests a loop inside a conditional. That is not stylistic:
; a nested `${While}` inside `${If}` inside `${If}` compiled to code that
; silently skipped the enclosing block's body, so the refusal was unreachable
; while the scan demonstrably ran. The wait is therefore expressed as an
; unrolled counter comparison driven from the top level of the function rather
; than as a nested loop, and it is the shape the runtime test exercises.

!include "LogicLib.nsh"

; ===========================================================================
; LOCALIZED MESSAGES: WHAT THE ORDERING PROBLEM IS AND HOW IT IS SOLVED
; ===========================================================================
;
; Tauri's `installer.nsi` has this order (tauri-bundler 2.9.4):
;
;   line 22-32   !include MUI2.nsh / FileFunc.nsh / LogicLib.nsh / ...
;   line 34-36   !include "{{installer_hooks}}"     <- this file, via the hooks
;   ...
;   line 469-471 !insertmacro MUI_LANGUAGE "..."     <- ${LANG_*} defined HERE
;   line 473-475 !include "<custom language files>"  <- installer-strings.nsh
;
; `LANG_ENGLISH` / `LANG_SIMPCHINESE` DO NOT EXIST at line 34. A `LangString`
; written from this file therefore cannot name a language, and makensis warns
; 7025 and assigns BOTH languages to id 1033, collapsing the translations.
;
; THE FALSE FIX, AND WHY IT IS NOT USED. A `!ifdef DSH_INSTALLER_STRINGS_DECLARED`
; branch that falls back to a hard-coded English literal compiles, and the English
; installer works - which is why the earlier version of this file looked correct.
; But the define is only set when a caller happens to include the strings file
; BEFORE this one, and in Tauri's real order nothing does: this file includes only
; `LogicLib.nsh`. MEASURED, with the template's own ordering (hooks at 34-36,
; languages at 469-471), `$(DSH_INSTALLER_RUNNING)` resolved to the EMPTY string
; and the guard fell back to the literal, so the SimpChinese installer displayed
; English for all three messages while the translations compiled unused.
;
; THE ACTUAL FIX. Two independent things must both be true:
;
;   1. `installer-strings.nsh` must be INCLUDED BY THIS FILE, so no caller can
;      forget it. (`!include` is attempted below, directly.)
;   2. The `LangString` DECLARATIONS must be EMITTED AT LINE 469-475, after
;      `MUI_LANGUAGE`, because that is the only point where `${LANG_*}` is
;      defined. An include at line 34 cannot do this, so the strings file is
;      included here for its MACRO DEFINITION and the declarations are emitted
;      into the language position by `DSH_INSTALLER_EMIT_STRINGS` (see below).
;
; The message text is therefore never baked into a `!define` at this point. The
; guard refers to the `LangString` NAMES, and NSIS resolves `$(...)` when the
; installer runs - by which time both languages are registered. The English
; literal remains ONLY as a compile-time fallback for a bare compile that never
; emits the strings, and that fallback is *proved* non-empty by a test.

; ---- 1. genuinely include the strings module -------------------------------
;
; `installer-strings.nsh` defines `DSH_INSTALLER_EMIT_STRINGS` and sets
; `DSH_INSTALLER_STRINGS_INCLUDED`. Including it here is what makes the claim in
; `installer-hooks.nsh` true, and it is idempotent (the file guards itself).
;
; Its path is resolved relative to THIS file so the include works regardless of
; the caller's working directory or how Tauri's bundler names the hooks file.
; `!ifndef` keeps it overridable for callers that supply their own copy.
!ifndef DSH_INSTALLER_STRINGS_FILE
  !define DSH_INSTALLER_STRINGS_FILE "${__FILEDIR__}\installer-strings.nsh"
!endif
!include "${DSH_INSTALLER_STRINGS_FILE}"

; ---- 2. the message identifiers the guard reports through ------------------
;
; When the strings module was included (the only supported configuration), the
; guard references the LANGUAGE-INDEPENDENT `LangString` names, so the correct
; translation is selected at run time by `$LANGUAGE`. Nothing is resolved at
; compile time, which is what makes SimpChinese reachable.
;
; If a caller compiled this file with no strings module at all, the names would
; expand to the empty string and an empty error reads as "nothing was wrong" -
; a fail-open default that would approve installing over a running application.
; The literal fallback exists ONLY for that case, and the port's test suite
; asserts the fallback is non-empty and that the real ordering takes the
; localized branch instead.
!ifdef DSH_INSTALLER_STRINGS_MACROS_DEFINED
  !define DSH_MSG_RUNNING "$(DSH_INSTALLER_RUNNING)"
  !define DSH_MSG_INDETERMINATE "$(DSH_INSTALLER_INDETERMINATE)"
  !define DSH_MSG_RELAUNCH_FAILED "$(DSH_INSTALLER_RELAUNCH_FAILED)"
!else
  !define DSH_MSG_RUNNING "DeepSeek Harness is still running. Close every DeepSeek Harness window (including the tray icon) and run this installer again. Nothing running was stopped, because another installation of the same product may be using it."
  !define DSH_MSG_INDETERMINATE "The running applications could not be inspected, so this installer stopped before changing anything. Close every DeepSeek Harness window and run this installer again. If this repeats, restart Windows and retry."
  !define DSH_MSG_RELAUNCH_FAILED "DeepSeek Harness was installed, but could not be started automatically. Start it from the Start menu."
!endif

; Bounded wait before giving up on an exiting application: 40 x 250 ms = 10 s,
; longer than a normal shutdown and short enough that a stuck process produces a
; refusal rather than an apparently frozen installer.
!define DSH_WAIT_ATTEMPTS 40
!define DSH_WAIT_INTERVAL_MS 250

; Shared state.
;
; Declared HERE, in the included module, because Tauri's `installer.nsi` includes
; the hooks file at line 34-36 while declaring its own `Var`s at lines 73-77. A
; hook that used a variable only the template declares would reference it before
; it exists, and makensis fails the whole script with `Usage: Pop
; $(user_var: output)` -- an error that names the symptom, not the ordering.
; An include is expanded IN PLACE, so a `Var` in this file is emitted at the
; include's position, not hoisted above it: what makes a declaration safe is that
; it is emitted before the line that reads the name, which is why the mode Vars
; below are ordered and guarded the way they are. None of the names in this block
; is read before this point by anything in the port's files, so one unconditional
; declaration site is enough for them.
Var dshInstallerError
Var dshNameRunningCount
Var dshWaitCount
Var dshWaitTimedOut
Var dshScanResult
Var dshScanStackCheck
Var dshRelaunchArgs
Var dshRelaunchRequested
Var dshRelaunchResult
Var dshRelaunchHandled
Var dshCapture

; The template's mode Vars, declared here ONLY for callers that do not declare
; them first. The functions below read `$UpdateMode` and are compiled as this file
; is included, while the stock template declares both names after its own hooks
; include - so a template-order compile would reach those reads with neither name
; in scope.
;
; MEASURED, NSIS 3.11 on this host, standalone scripts, because an earlier version
; of this comment asserted the opposite of both facts:
;
;   * `Var X` twice is a HARD failure - `Error: variable "X" already declared` -
;     so this block must not re-declare what the caller already declared. The
;     duplicate only ever looked harmless because the fixture in use then declared
;     neither name, so nothing emitted a second one.
;   * deleting this block is NOT a fix either. Where a read of an undeclared name
;     sits in an OUTPUT position it is a hard `Usage: StrCpy $(user_var: output)`;
;     where it sits in a LogicLib comparison the build SUCCEEDS and the name
;     silently expands to nothing (warning 6000), which is how the guard's
;     `$UpdateMode` branch would stop running unnoticed.
;
; The sentinel therefore keeps exactly one declaration site in either
; arrangement: `installer-template.nsi` (and the port's template-order fixture)
; defines `DSH_TEMPLATE_MODE_VARS_DECLARED` above the hooks include and declares
; both Vars there, so this block is skipped; a bare fixture with no template
; leaves the sentinel undefined and gets the declarations here, ahead of the
; reads. `Var` cannot be tested for directly by makensis, which is why the
; decision is carried by a paired `!define` in the caller.
!ifndef DSH_TEMPLATE_MODE_VARS_DECLARED
  Var UpdateMode
  Var PassiveMode
!endif

; The executable name whose presence this guard checks.
;
; Tauri's `installer.nsi` defines `${MAINBINARYNAME}` at line 52, but includes the
; registered hooks file at line 34-36, BEFORE that. A hook that referenced
; `${MAINBINARYNAME}` would therefore expand it to nothing at include time and
; the scan would search for ".exe". The port's executable name is fixed
; (`[[bin]] name = "dsh-desktop"` in `port/src-tauri/app/Cargo.toml`), so it is
; defined here and the installer supplies the same value through the template.
; `!ifndef` keeps the template's definition authoritative if it is ever set first.
!ifndef DSH_MAIN_BINARY_NAME
  !define DSH_MAIN_BINARY_NAME "dsh-desktop"
!endif

; Presence scan. Sets $dshNameRunningCount: 1 present, 0 absent, -1 unreadable.
;
; THE SENTINEL PROTOCOL, AND WHY A BARE `Pop` IS NOT SAFE.
;
; NSIS keeps a `Call`'s return address on the same stack `Push`/`Pop` use, so a
; function that pops more values than were pushed does not merely read garbage -
; it consumes the caller's return address, and `FunctionEnd`'s `Return` then
; jumps to whatever happened to be underneath. A plugin that pushes no result is
; exactly that case, and the earlier version of this file popped unconditionally.
;
; The sentinel is therefore armed before the call and the pop count is fixed:
;
;   Push "DSH_PROCESS_SCAN_NO_RESULT"              ; armed before the plugin call
;   nsis_tauri_utils::FindProcessCurrentUser ...    ; pushes one value, or none
;   Pop $dshScanResult                             ; that value, OR the sentinel
;
; If the plugin pushed nothing, `$dshScanResult` IS the sentinel: it is reported
; as indeterminate and it is already consumed, so no second pop happens. If the
; plugin did push a value, the sentinel is still below it; a second pop consumes
; and verifies it. Every branch pops exactly what it pushed plus what the plugin
; pushed, so the return address is never reached. A value that is not exactly
; "0" or "1", or a sentinel that is not intact, stays indeterminate instead of
; being coerced into an observation.
Function DshProcessCountByName
  Push "DSH_PROCESS_SCAN_NO_RESULT"
  nsis_tauri_utils::FindProcessCurrentUser "${DSH_MAIN_BINARY_NAME}.exe"
  Pop $dshScanResult
  StrCpy $dshNameRunningCount -1
  ${If} $dshScanResult == "DSH_PROCESS_SCAN_NO_RESULT"
    ; No observation was pushed. -1 already means indeterminate, and both callers
    ; treat that as a refusal.
  ${Else}
    ; 0 means at least one process matched; 1 means none did (tauri-bundler
    ; utils.nsh:39 branches on `$R0 = 0` meaning "running"). The sentinel must
    ; still be intact below the observation before either reading is trusted.
    Pop $dshScanStackCheck
    ${If} $dshScanStackCheck == "DSH_PROCESS_SCAN_NO_RESULT"
    ${AndIf} $dshScanResult == "0"
      StrCpy $dshNameRunningCount 1
    ${ElseIf} $dshScanStackCheck == "DSH_PROCESS_SCAN_NO_RESULT"
    ${AndIf} $dshScanResult == "1"
      StrCpy $dshNameRunningCount 0
    ${EndIf}
  ${EndIf}
FunctionEnd

; Wait, bounded, for a running instance to exit. Sets $dshWaitCount to the number
; of intervals waited.
;
; The loop is a `Goto`-driven back edge rather than a LogicLib loop. LogicLib's
; `${While}`/`${DoWhile}` generate label pairs that did not survive being nested
; two conditionals deep in this script; a plain label and a conditional `Goto`
; have no such interaction and are what the runtime test verifies.
Function DshWaitForInstanceExit
  StrCpy $dshWaitCount 0
  StrCpy $dshWaitTimedOut 1

  dsh_wait_loop:
    ${If} $dshWaitCount >= ${DSH_WAIT_ATTEMPTS}
      Goto dsh_wait_done
    ${EndIf}

    Sleep ${DSH_WAIT_INTERVAL_MS}
    Call DshProcessCountByName
    IntOp $dshWaitCount $dshWaitCount + 1

    ${If} $dshNameRunningCount = 0
      ; The application exited; the update may proceed.
      StrCpy $dshWaitTimedOut 0
      Goto dsh_wait_done
    ${EndIf}
    ${If} $dshNameRunningCount < 0
      ; The scan failed while waiting; the caller treats this as indeterminate.
      StrCpy $dshWaitTimedOut 2
      Goto dsh_wait_done
    ${EndIf}

    Goto dsh_wait_loop

  dsh_wait_done:
FunctionEnd

; Guard used by both the installer and the uninstaller.
;
;   in : $UpdateMode, ${DSH_MAIN_BINARY_NAME}
;   out: $dshInstallerError - empty when the installation may proceed
Function DshInstallerGuardRunningInstance
  StrCpy $dshInstallerError ""
  StrCpy $dshWaitCount 0

  Call DshProcessCountByName

  ; Indeterminate: the process list could not be read, so nothing is assumed.
  ${If} $dshNameRunningCount < 0
    StrCpy $dshInstallerError "${DSH_MSG_INDETERMINATE}"
  ${EndIf}

  ; Present.
  ${If} $dshInstallerError == ""
  ${AndIf} $dshNameRunningCount > 0
    ${If} $UpdateMode = 1
      Call DshWaitForInstanceExit
      ${If} $dshWaitTimedOut = 2
        StrCpy $dshInstallerError "${DSH_MSG_INDETERMINATE}"
      ${EndIf}
    ${EndIf}

    ; Re-read presence from the wait, or keep the initial finding when this is
    ; not an update. A refusal is issued only when the instance is demonstrably
    ; still there.
    ${If} $dshInstallerError == ""
    ${AndIf} $dshNameRunningCount > 0
      StrCpy $dshInstallerError "${DSH_MSG_RUNNING}"
    ${EndIf}
  ${EndIf}
FunctionEnd

; The uninstaller's entry point for the same guard.
;
; WHY THIS WRAPPER IS MANDATORY, AND WHY IT IS NOT THE SAME FUNCTION.
;
; `NSIS_HOOK_PREUNINSTALL` is expanded inside `Section Uninstall`, which belongs
; to the UNINSTALLER's function table. MEASURED with the real module compiled
; into a Tauri-shaped script that actually emits an uninstaller:
;
;   Error: resolving uninstall function "un.DshInstallerGuardRunningInstance" in
;          uninstall section "" (0)
;   Note: uninstall functions must begin with "un.", and install functions must
;         not
;
; NSIS builds two separate function tables. A `Function` declared without the
; `un.` prefix is compiled into the INSTALLER's table only, so a `Call un.X` from
; an uninstall section cannot resolve it - the script does not compile at all.
; The `un.` prefix on a `Call` is not a namespace lookup into the installer's
; functions; it names a function that must be declared `Function un.X`.
;
; (An earlier version of the port's fixture passed this check only because it
; never called `WriteUninstaller`, so makensis discarded the uninstaller entirely
; - warning 6020 - and the unresolved call was never compiled. See the fixture.)
;
; `un.DshInstallerGuardRunningInstance` duplicates the decision rather than
; factoring it out, because the helpers it calls (`DshProcessCountByName`,
; `DshWaitForInstanceExit`, `DshInstallerRelaunch`) would each need an `un.`
; twin as well. The duplication is confined to the branch structure; every
; message and every threshold still comes from this file, so the installer and
; uninstaller copies cannot drift in what they DO, only in being separate code.
Function un.DshInstallerGuardRunningInstance
  StrCpy $dshInstallerError ""
  StrCpy $dshWaitCount 0

  Call un.DshProcessCountByName

  ${If} $dshNameRunningCount < 0
    StrCpy $dshInstallerError "${DSH_MSG_INDETERMINATE}"
  ${EndIf}

  ${If} $dshInstallerError == ""
  ${AndIf} $dshNameRunningCount > 0
    ${If} $UpdateMode = 1
      Call un.DshWaitForInstanceExit
      ${If} $dshWaitTimedOut = 2
        StrCpy $dshInstallerError "${DSH_MSG_INDETERMINATE}"
      ${EndIf}
    ${EndIf}

    ${If} $dshInstallerError == ""
    ${AndIf} $dshNameRunningCount > 0
      StrCpy $dshInstallerError "${DSH_MSG_RUNNING}"
    ${EndIf}
  ${EndIf}
FunctionEnd

; The uninstaller's own copies of the two helpers the guard calls. See the note on
; `un.DshInstallerGuardRunningInstance` for why these exist as `un.` twins.
; The uninstaller's copy of the same sentinel protocol. The two function tables
; are separate, so neither copy can call the other, and a divergence would mean
; one of the two paths fails open. Keep this body equivalent to the installer's.
Function un.DshProcessCountByName
  Push "DSH_PROCESS_SCAN_NO_RESULT"
  nsis_tauri_utils::FindProcessCurrentUser "${DSH_MAIN_BINARY_NAME}.exe"
  Pop $dshScanResult
  StrCpy $dshNameRunningCount -1
  ${If} $dshScanResult == "DSH_PROCESS_SCAN_NO_RESULT"
    ; No observation was pushed; the sentinel is already consumed.
  ${Else}
    Pop $dshScanStackCheck
    ${If} $dshScanStackCheck == "DSH_PROCESS_SCAN_NO_RESULT"
    ${AndIf} $dshScanResult == "0"
      StrCpy $dshNameRunningCount 1
    ${ElseIf} $dshScanStackCheck == "DSH_PROCESS_SCAN_NO_RESULT"
    ${AndIf} $dshScanResult == "1"
      StrCpy $dshNameRunningCount 0
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.DshWaitForInstanceExit
  StrCpy $dshWaitCount 0
  StrCpy $dshWaitTimedOut 1

  un_dsh_wait_loop:
    ${If} $dshWaitCount >= ${DSH_WAIT_ATTEMPTS}
      Goto un_dsh_wait_done
    ${EndIf}

    Sleep ${DSH_WAIT_INTERVAL_MS}
    Call un.DshProcessCountByName
    IntOp $dshWaitCount $dshWaitCount + 1

    ${If} $dshNameRunningCount = 0
      StrCpy $dshWaitTimedOut 0
      Goto un_dsh_wait_done
    ${EndIf}
    ${If} $dshNameRunningCount < 0
      StrCpy $dshWaitTimedOut 2
      Goto un_dsh_wait_done
    ${EndIf}

    Goto un_dsh_wait_loop

  un_dsh_wait_done:
FunctionEnd

; Relaunch the installed application, once, from $INSTDIR.
;
; `RunAsUser` starts the process as the interactive user rather than as the
; installer's (possibly elevated) identity, which keeps the relaunched
; application's $DSH_HOME and %APPDATA% pointing at the user who installed it.
; It returns 0 on success, pushed onto the plugin stack; a failure is reported on
; the detail pane rather than failing an otherwise finished installation.
;
; `$dshRelaunchHandled` makes the launch idempotent. Tauri's own `.onInstSuccess`
; (installer.nsi:743-754) independently relaunches for `/R` on silent and passive
; installs, so an unconditional relaunch here produced TWO application starts per
; update - measured, not inferred: a silent `/UPDATE /R /ARGS=...` run of the
; hook shape launched twice, which risks two instances competing for the same
; `$DSH_HOME` lock. The first relaunch wins and later callers are no-ops.
Function DshInstallerRelaunch
  ${If} $dshRelaunchHandled = "1"
    DetailPrint "the application was already relaunched; skipping a duplicate launch"
    Return
  ${EndIf}
  StrCpy $dshRelaunchHandled "1"

  ${If} $dshRelaunchArgs == ""
    nsis_tauri_utils::RunAsUser "$INSTDIR\${DSH_MAIN_BINARY_NAME}.exe" ""
  ${Else}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${DSH_MAIN_BINARY_NAME}.exe" "$dshRelaunchArgs"
  ${EndIf}
  Pop $dshRelaunchResult
  ${If} $dshRelaunchResult != 0
    DetailPrint "${DSH_MSG_RELAUNCH_FAILED}"
  ${EndIf}
FunctionEnd

; Normalize an `${GetOptions} $CMDLINE "/ARGS"` result into a launch-argument
; string the application can actually parse.
;
; MEASURED against NSIS 3.11's `FileFunc.nsh` (`GetOptionsBody`): `GetOptions`
; does NOT consume a `=` separator, so the updater's documented
; `/ARGS=<value>` invocation yields `=--restore-session` - a leading `=` that
; would arrive as a malformed first argument. The two-token form `/ARGS <value>`
; yields the value unchanged, and a value containing spaces (`/ARGS=--a --b`)
; fails the option match entirely (${Errors} set). Stripping one leading `=` makes
; the documented form behave the way the caller intended.
Function DshNormalizeLaunchArgs
  ; in/out: $dshRelaunchArgs
  StrCpy $0 $dshRelaunchArgs 1
  ${If} $0 == "="
    StrCpy $dshRelaunchArgs $dshRelaunchArgs "" 1
  ${EndIf}
FunctionEnd
