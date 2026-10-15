Unicode true
; Resource SOURCE path-length fixture for the bundle's `bundle.resources` walk.
;
; `tauri-bundler` joins each `bundle.resources` key onto the app directory without
; collapsing it, so the generated installer names every resource source as
; `<repo>\port\src-tauri\app\..\..\runtime-payload\dsh\<file>`. NSIS's `File`
; opens that SOURCE through a Win32 path that must stay under MAX_PATH, and the
; un-collapsed `src-tauri\app\..\..\` prefix costs 20 characters per path.
;
; This fixture is compiled once per spelling of the SAME real resource file, so the
; compile itself proves which spellings NSIS can open. It is never shipped and is
; NEVER EXECUTED; the compile is the whole test.
;
; MEASURED with real makensis on this host, against the real file the bundle died
; on (`...\selectElementAccessibilityInteractiveContentAttributesSelectDescendant.md`):
;
;   241 characters (canonical)                        -> exit 0
;   259 characters (same file, padded with `.\`)       -> exit 0
;   260 characters                                     -> `File: failed opening file`
;   261 characters (the spelling the bundle used)      -> `File: failed opening file`
;
; The parenthesised spellings in that table are the same file reached through
; redundant path components, which is exactly what the un-collapsed `..` prefix is:
; no alias, junction, copy or exclusion is involved anywhere in this fixture.

!ifndef DSH_RES_SOURCE
  !error "DSH_RES_SOURCE must be defined to the resource source path under test"
!endif
!ifndef DSH_RES_OUT
  !error "DSH_RES_OUT must be defined to the compile output path"
!endif
!ifndef DSH_RES_UNINST
  !error "DSH_RES_UNINST must be defined to the uninstaller output path"
!endif

Name "dsh-resource-source-path-preflight"
OutFile "${DSH_RES_OUT}"
InstallDir "$TEMP\dsh-resource-source-path-preflight"
SilentInstall silent
RequestExecutionLevel user

Section
  ; The command under test: one resource source, exactly as the generated installer
  ; writes it (the real template emits `File /a "/oname=dsh\<relative>" "<source>"`).
  File /a "/oname=dsh\payload.md" "${DSH_RES_SOURCE}"
SectionEnd

; Written so the script is a real installer and the uninstaller is not discarded
; with warning 6020, which would otherwise be the only thing in the log.
Section -InstallExtras
  WriteUninstaller "${DSH_RES_UNINST}"
SectionEnd

Section Uninstall
  Delete "$INSTDIR\dsh\payload.md"
SectionEnd
