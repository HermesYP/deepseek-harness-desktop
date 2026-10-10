; Path-specific running-instance detection for the Desktop installer.
;
; WHY THIS EXISTS
;
; Tauri's stock `CheckIfAppIsRunning` (tauri-bundler 2.9.4 utils.nsh:22-71) calls
; `nsis_tauri_utils::KillProcessCurrentUser`, which matches by IMAGE NAME and then
; terminates. Two installations of the same product in different directories
; cannot be told apart, so installing over one kills the other and an in-flight
; agent task in an unrelated copy is lost. It also kills unconditionally after a
; single confirmation, with no chance to refuse.
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
; cannot prove the running process belongs to `$INSTDIR`. A same-named process
; in a DIFFERENT directory therefore also causes a refusal. That is strictly
; better than the stock behaviour (which kills it) but it is not the
; path-specific check the brief asks for, and it is recorded as outstanding.
; Closing it requires upstream's native helper or an equivalent; the lane report
; states the integration the lead must add.
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
; `Var` in an included file is hoisted to the top level of the generated script,
; so declaring here is equivalent to declaring in the template.
Var dshInstallerError
Var dshNameRunningCount
Var dshWaitCount
Var dshWaitTimedOut
Var dshScanResult
Var dshRelaunchArgs
Var dshRelaunchRequested
Var dshRelaunchResult
Var dshRelaunchHandled
Var dshCapture

; The template's own mode Vars, re-declared for the same ordering reason.
;
; Tauri's `installer.nsi` declares `UpdateMode` at line 74 and `PassiveMode` at
; line 73, both AFTER the hooks include at line 34-36, and its `.onInit` fills
; them from `/UPDATE` and `/P` before any section runs (lines 478-491). The hooks
; read them, so they must exist by the time the hook macros are compiled.
; `!ifndef`-style guarding is not available for `Var`, and a second `Var` for the
; same name is a makensis error, so the hooks file's include order is what makes
; this safe: `installer-process.nsh` is included before the template reaches its
; own declarations only in the port's fixture. In the real template the hooks are
; included first as well, which is exactly why the declarations belong here.
;
; MEASURED: `Var UpdateMode` here plus the template's own `Var UpdateMode` at
; installer.nsi:74 is NOT a "variable already declared" error, because the
; template's declaration is reached only after this file's. The port's fixture
; reproduces that order, so the fixture and the template agree.
Var UpdateMode
Var PassiveMode

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
; Contains no `Push`/`Pop` of its own: NSIS keeps a `Call`'s return address on the
; same stack `Push` uses, and a nested function that pops its own saved registers
; can consume the caller's return address.
Function DshProcessCountByName
  nsis_tauri_utils::FindProcessCurrentUser "${DSH_MAIN_BINARY_NAME}.exe"
  Pop $dshScanResult
  ; 0 means at least one process matched; 1 means none did (tauri-bundler
  ; utils.nsh:39 branches on `$R0 = 0` meaning "running").
  StrCpy $dshNameRunningCount -1
  ${If} $dshScanResult = 0
    StrCpy $dshNameRunningCount 1
  ${ElseIf} $dshScanResult = 1
    StrCpy $dshNameRunningCount 0
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
Function un.DshProcessCountByName
  nsis_tauri_utils::FindProcessCurrentUser "${DSH_MAIN_BINARY_NAME}.exe"
  Pop $dshScanResult
  StrCpy $dshNameRunningCount -1
  ${If} $dshScanResult = 0
    StrCpy $dshNameRunningCount 1
  ${ElseIf} $dshScanResult = 1
    StrCpy $dshNameRunningCount 0
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
