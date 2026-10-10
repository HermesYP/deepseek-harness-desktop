Unicode true
; Runtime fixture proving the installer guard messages are ACTUALLY localized.
;
; WHY THIS EXISTS
;
; `installer-strings.nsh` declares the same three messages for English and
; SimpChinese. Neither a compile check nor a grep can show that a user of the
; SimpChinese installer SEES SimpChinese, and this port was green twice while the
; translation was unreachable:
;
;   * the guard reported a hard-coded English literal, because the strings file
;     was never included by `installer-process.nsh` at all;
;   * an intermediate attempt included it, but guarded the entire file body with a
;     single `!ifndef`. The line-34 include (before any language exists) consumed
;     that guard, so the line-473 include became a no-op: warning 6040 for every
;     string and `$(...)` resolving to the EMPTY string - which the guard reads as
;     "nothing was wrong". That is a fail-open default, not merely missing i18n.
;
; ORDER, AND WHY IT IS THE POINT OF THIS FIXTURE
;
; This file reproduces Tauri's `installer.nsi` order exactly (tauri-bundler
; 2.9.4):
;
;   line 34-36   the registered hooks file        <- this pulls in
;                                                    installer-process.nsh, which
;                                                    now includes installer-strings.nsh
;   line 469-471 !insertmacro MUI_LANGUAGE "..."  <- ${LANG_*} defined HERE
;   line 473-475 customLanguageFiles              <- installer-strings.nsh AGAIN
;
; The hooks are included BEFORE any language exists, which is what broke the naive
; include, and the strings file is included again after the languages, which is
; what makes the declarations valid.
;
; HOW THE LANGUAGE IS FORCED
;
; `.onInit` sets `$LANGUAGE` from `${PROBE_LANG}` (1033 English, 2052
; SimpChinese). `MUI_LANGDLL` would otherwise choose from the host locale, which
; is not deterministic on a build host.
;
; WHY THE EXPECTED TEXT ARRIVES AS A /D DEFINE, NOT AS A SOURCE LITERAL
;
; MEASURED, and this is the subtle part. Two encodings are in play:
;
;   * a `LangString` value read from an INCLUDED BOM-less UTF-8 file is decoded
;     correctly - verified by finding the declared SimpChinese sentence verbatim
;     in the compiled string table;
;   * a CJK LITERAL in this TOP-LEVEL .nsi is NOT decoded correctly when the file
;     is BOM-less UTF-8, so a comparison written that way silently reports NO even
;     though the message is right.
;
; So this fixture holds NO CJK literals. The expected strings are supplied by the
; driver script as `/D` defines (`PROBE_ZH_RUNNING`, ...), which are passed on the
; command line as UTF-16 and reach makensis intact - measured. That removes the
; fixture's own encoding from the question and makes the assertion about the
; LangString, which is the thing under test.
;
; WHY THE FILE WRITES ONLY ASCII VERDICTS
;
; MEASURED: `FileWrite` converts non-codepage text to `0x3F` ('?'); even a CJK
; literal written by an installer becomes `????`. That is a limitation of the
; probe's output path, not of the strings file, so the fixture never writes the
; message. It compares `$(...)` at run time and records YES/NO.

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifdef DSH_PLUGIN_DIR
  !addplugindir "${DSH_PLUGIN_DIR}"
!endif

OutFile "${PROBE_OUT}"
Name "dsh-strings-message-probe"
InstallDir "$TEMP\dsh-strings-message-probe"
SilentInstall silent
; NSIS defaults to requireAdministrator, which would make this fixture wait on a
; UAC prompt and never terminate in an unelevated test run.
RequestExecutionLevel user

!ifndef PROBE_LANG
  !define PROBE_LANG 1033
!endif

Var fh
Var dshMsg

; --- Tauri installer.nsi line 34-36: the hooks file ------------------------
!ifndef DSH_INSTALLER_HOOKS
  !error "DSH_INSTALLER_HOOKS must point at the port's installer-hooks.nsh"
!endif
!include "${DSH_INSTALLER_HOOKS}"

; --- Tauri installer.nsi line 469-471: languages ---------------------------
!insertmacro MUI_RESERVEFILE_LANGDLL
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; --- Tauri installer.nsi line 473-475: customLanguageFiles -----------------
!ifndef DSH_INSTALLER_STRINGS
  !error "DSH_INSTALLER_STRINGS must point at the port's installer-strings.nsh"
!endif
!include "${DSH_INSTALLER_STRINGS}"

Function .onInit
  StrCpy $LANGUAGE ${PROBE_LANG}
FunctionEnd

!macro PROBE_CHECK NAME EXPECTED
  StrCpy $dshMsg "$(${NAME})"
  ; The fail-open property: an undefined LangString resolves to "", and an empty
  ; guard error is read as "nothing was wrong". This must never be YES.
  ${If} $dshMsg == ""
    FileWrite $fh "${NAME}_EMPTY=YES$\r$\n"
  ${Else}
    FileWrite $fh "${NAME}_EMPTY=NO$\r$\n"
  ${EndIf}
  ${If} $dshMsg == "${EXPECTED}"
    FileWrite $fh "${NAME}_MATCH=YES$\r$\n"
  ${Else}
    FileWrite $fh "${NAME}_MATCH=NO$\r$\n"
  ${EndIf}
!macroend

Section
  FileOpen $fh "${PROBE_DIR}\verdict.txt" w
  FileWrite $fh "LANGUAGE=$LANGUAGE$\r$\n"

  ; Each comparison is against the expected text for the ACTIVE language, passed
  ; in by the driver. A translation attached to the wrong name, a missing entry,
  ; or a collapsed language table all produce _MATCH=NO.
  !if ${PROBE_LANG} == 2052
    !insertmacro PROBE_CHECK DSH_INSTALLER_RUNNING "${PROBE_ZH_RUNNING}"
    !insertmacro PROBE_CHECK DSH_INSTALLER_INDETERMINATE "${PROBE_ZH_INDETERMINATE}"
    !insertmacro PROBE_CHECK DSH_INSTALLER_RELAUNCH_FAILED "${PROBE_ZH_RELAUNCH}"
  !else
    !insertmacro PROBE_CHECK DSH_INSTALLER_RUNNING "${PROBE_EN_RUNNING}"
    !insertmacro PROBE_CHECK DSH_INSTALLER_INDETERMINATE "${PROBE_EN_INDETERMINATE}"
    !insertmacro PROBE_CHECK DSH_INSTALLER_RELAUNCH_FAILED "${PROBE_EN_RELAUNCH}"
  !endif

  FileClose $fh
  SetErrorLevel 0
SectionEnd

Section Uninstall
SectionEnd
