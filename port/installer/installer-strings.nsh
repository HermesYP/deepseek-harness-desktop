; Localized messages for the DeepSeek Harness Desktop installer hooks.
;
; WHY THIS FILE EXISTS SEPARATELY, AND WHY IT IS INCLUDED TWICE-ROLE
;
; Tauri's `installer.nsi` (tauri-bundler 2.9.4) has this order:
;
;   line 22-32  !include MUI2.nsh, FileFunc.nsh, LogicLib.nsh
;   line 34-36  !include "{{installer_hooks}}"   <- the port's hooks file
;   ...
;   line 469-471 !insertmacro MUI_LANGUAGE "SimpChinese" / "English"
;   line 473-475 !include "<custom language files>"   <- this file
;
; `LANG_ENGLISH` and `LANG_SIMPCHINESE` are defined by the `MUI_LANGUAGE` inserts,
; so they DO NOT EXIST at line 34 where the hooks file is included. A `LangString`
; written there with `${LANG_ENGLISH}` makes makensis warn 7025 ("not a valid
; language id, using language id 1033") and then assign BOTH languages to id
; 1033, which silently collapses the translations into one.
;
; THIS FILE IS THEREFORE INCLUDED FROM TWO PLACES, ON PURPOSE:
;
;   1. `installer-process.nsh` includes it at line 34 (the hooks position). That
;      include DEFINES THE MACROS BELOW and sets `DSH_INSTALLER_STRINGS_INCLUDED`,
;      which is what makes "the caller cannot forget the messages" true. It
;      deliberately does NOT declare any `LangString`: `${LANG_*}` is undefined
;      there and the declaration would be misattributed.
;
;   2. Tauri's `customLanguageFiles` entry includes it AGAIN at line 473-475,
;      after `MUI_LANGUAGE`. At that point `${LANG_*}` IS defined, so the
;      `LangString` declarations below compile into the right language tables.
;
; The include is guarded, so place 2 is a no-op for the DECLARATIONS if place 1
; somehow reached them first - but place 1 cannot, because the declarations are
; inside `!macro`, not at file scope.
;
; The literal fallback in `installer-process.nsh` matters: `$(NAME)` for an
; undefined LangString resolves to the EMPTY string, and the guard treats an empty
; error as "nothing was wrong", so a missing translation is a fail-open default
; rather than a visible gap. That fallback is only reachable from a compile that
; never emits these strings, which the port's tests assert.

; ---- macros ----------------------------------------------------------------
;
; `!include` cannot be conditional on `${LANG_*}` being defined (there is no way
; to test for a language define that may not exist yet in a way that survives all
; makensis versions), so the declarations are emitted from a macro that the
; template's language position expands. Calling it more than once is harmless:
; the inner `!ifndef` makes the second expansion a no-op.

; The macro DEFINITION is guarded so re-including the file is harmless; the
; EMISSION below is deliberately NOT inside that guard. MEASURED: wrapping both
; in one `!ifndef` made the second include a complete no-op - the line-34 include
; defined the guard while `LANG_ENGLISH` was still undefined, so the emission was
; skipped there AND skipped at line 473, leaving warning 6040 for every string
; and `$(DSH_INSTALLER_RUNNING)` resolving to the EMPTY string.
!ifndef DSH_INSTALLER_STRINGS_MACROS_DEFINED
!define DSH_INSTALLER_STRINGS_MACROS_DEFINED

; Emit the `LangString` declarations. MUST be expanded after `MUI_LANGUAGE`,
; because `${LANG_ENGLISH}` inside a macro is expanded at INSERTION time.
; MEASURED: `${LANG_*}` inside a macro inserted after the `MUI_LANGUAGE` calls
; resolves to the correct ids, while the same macro inserted before them resolves
; to nothing.
!macro DSH_INSTALLER_EMIT_STRINGS
  !ifndef DSH_INSTALLER_STRINGS_DECLARED
  !define DSH_INSTALLER_STRINGS_DECLARED

LangString DSH_INSTALLER_RUNNING ${LANG_ENGLISH} "DeepSeek Harness is still running.$\r$\n$\r$\nClose every DeepSeek Harness window (including the tray icon) and run this installer again. Nothing running was stopped, because another installation of the same product may be using it."
LangString DSH_INSTALLER_RUNNING ${LANG_SIMPCHINESE} "DeepSeek Harness 仍在运行。$\r$\n$\r$\n请关闭所有 DeepSeek Harness 窗口（包括托盘图标）后重新运行安装程序。安装程序没有结束任何正在运行的应用，因为同一产品的其他安装可能正在使用它。"

LangString DSH_INSTALLER_INDETERMINATE ${LANG_ENGLISH} "The running applications could not be inspected, so this installer stopped before changing anything.$\r$\n$\r$\nClose every DeepSeek Harness window and run this installer again. If this repeats, restart Windows and retry."
LangString DSH_INSTALLER_INDETERMINATE ${LANG_SIMPCHINESE} "无法检查正在运行的应用，因此安装程序在做出任何更改前已停止。$\r$\n$\r$\n请关闭所有 DeepSeek Harness 窗口后重新运行安装程序。如果问题依旧，请重启 Windows 后重试。"

LangString DSH_INSTALLER_RELAUNCH_FAILED ${LANG_ENGLISH} "DeepSeek Harness was installed, but could not be started automatically. Start it from the Start menu."
LangString DSH_INSTALLER_RELAUNCH_FAILED ${LANG_SIMPCHINESE} "DeepSeek Harness 已安装，但无法自动启动。请从开始菜单启动。"

  !endif
!macroend

!endif

; ---- declarations at the include site --------------------------------------
;
; Runs on EVERY include, which is what lets the late (line 473) include be the
; one that emits. The `!ifdef LANG_ENGLISH` test distinguishes the two include
; positions: at line 34 no language is inserted yet, so `${LANG_*}` is undefined
; and declaring a `LangString` there would warn 7025 and collapse BOTH languages
; onto id 1033. At line 473 the defines exist and the declarations are valid.
;
; When neither position emitted (a caller compiled this file with no languages at
; all), `installer-process.nsh` uses its literal fallback - never an empty
; message, because an empty guard error reads as "nothing was wrong".
!ifdef LANG_ENGLISH
  !insertmacro DSH_INSTALLER_EMIT_STRINGS
!endif
