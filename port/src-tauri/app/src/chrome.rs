//! Windows caption chrome: the DOM the shared client styles scope on, the
//! caption menu labels, the caption palette the renderer measures, and the
//! native frame that palette paints.
//!
//! Upstream sources mirrored here:
//! - `preload-platform.ts:10-17` — `html[data-platform=<process.platform>].
//! - `preload-windows.ts:8-18` — `html[data-windows-titlebar]` plus the
//!   `--dsh-windows-titlebar-height` custom property.
//! - `preload-menu.ts:10-113` — the caption menubar host, its shadow root, its
//!   editor-focus memory, and its `windowsMenu` popup request.
//! - `preload-windows.ts:21-58` — the caption palette probe: one hidden span
//!   carrying [`CAPTION_PROBE_CSS`], one canvas that normalizes the resolved
//!   colours to `rgba()`, and the `[lang, fill, symbol]` report.
//! - `main.ts:184-186,211-212,989-1000` — the fallback swatches, the caption
//!   colours the report reaches, and the per-field validation upstream applies.
//! - `windows-layout.ts:4` — `WINDOWS_TITLEBAR_HEIGHT`.
//!
//! Why an injected script rather than native Tauri menus: the released Windows
//! host exposes **no** application menu (`main.ts:924-927` builds only two
//! hidden devtools items) and instead paints `Application`/`Edit` buttons inside
//! the caption row itself. The shared client CSS reserves that row
//! (`ui-layout/AppFrame.module.css:26-55`) and positions the buttons after the
//! sidebar controls through `--dsh-windows-menu-start`
//! (`ui-sidebar/SidebarRoot.module.css:88-90`). A native Tauri menu bar would
//! add a second, unlocalized row the reference does not have, so this module
//! reproduces the reference's DOM instead.
//!
//! # Palette ownership
//!
//! Upstream hands the measured pair to `mainWindow.setTitleBarOverlay`, which
//! paints an operating-system caption bar the page does not own. The port's
//! window is frameless (`lib.rs` builds it with `decorations(false)`), so the
//! caption is DOM: the probe paints the caption row itself *and* reports the
//! pair, and [`apply_caption_palette`] applies the fill to the native frame the
//! operating system does paint — the frameless window's erase background and the
//! WebView2 backing behind the document. Both halves read one measurement, so
//! they cannot disagree about the theme.

use dsh_core::error::DshError;
use dsh_core::protocol::{LocaleId, Theme};

/// Windows application titlebar height in device-independent pixels
/// (`_upstream/apps/desktop/src/windows-layout.ts:4`).
pub const WINDOWS_TITLEBAR_HEIGHT: u32 = 40;

/// The caption-theme probe expression. It mirrors `preload-windows.ts:22`
/// exactly: the sidebar fill and the primary label colour are the two values
/// the caption uses, and both must resolve through the client's own tokens so a
/// custom theme keeps the caption consistent.
pub const CAPTION_PROBE_CSS: &str = "position:fixed;visibility:hidden;pointer-events:none;\
 background-color:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)";

/// The element id the injected caption menubar host carries, so a re-asserted
/// initialization script cannot mount a second bar.
pub const MENU_HOST_ID: &str = "dsh-native-menu";

/// The element id of the injected resize/drag layer that keeps a frameless
/// Windows window resizable without covering the caption row.
pub const GRIP_LAYER_ID: &str = "dsh-native-grips";

/// The command the probe reports a caption palette through. Upstream sends the
/// same three values over its `windowsAppearance` IPC
/// (`preload-windows.ts:45`, `main.ts:989`).
pub const CAPTION_PALETTE_COMMAND: &str = "shell_caption_palette";

/// The eight frameless resize grips: the CSS class suffix and the direction
/// name forwarded to `shell_window_resize_dragging`.
const GRIP_DIRECTIONS: [(&str, &str); 8] = [
    ("n", "North"),
    ("s", "South"),
    ("e", "East"),
    ("w", "West"),
    ("ne", "NorthEast"),
    ("nw", "NorthWest"),
    ("se", "SouthEast"),
    ("sw", "SouthWest"),
];

/// One caption-palette measurement produced by the renderer
/// (`preload-windows.ts:36-46`).
///
/// Every field is untrusted renderer input: the values cross into `eval`'d DOM
/// writes and into the native caption frame, so [`CaptionPalette::parse`]
/// rejects anything that is not an exact CSS colour and a BCP 47-shaped
/// language tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptionPalette {
    /// `document.documentElement.lang`, validated shape only.
    pub language: String,
    /// Resolved sidebar fill, e.g. `rgba(249, 250, 251, 1)`.
    pub fill: String,
    /// Resolved primary label colour.
    pub symbol: String,
}

/// Errors produced while validating renderer caption measurements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptionPaletteError {
    /// The language tag does not match the accepted BCP 47 subset.
    Language,
    /// A colour is not `#hex` or `rgb()/rgba()`.
    Color,
}

impl std::fmt::Display for CaptionPaletteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Language => formatter.write_str("caption language is not a language tag"),
            Self::Color => formatter.write_str("caption colour is not a CSS colour"),
        }
    }
}

impl std::error::Error for CaptionPaletteError {}

/// One CSS colour reduced to the channels the native frame paints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaptionRgb {
    red: u8,
    green: u8,
    blue: u8,
}

impl From<CaptionRgb> for tauri::webview::Color {
    /// The frame is opaque: the pinned Wry layer replaces any non-zero alpha
    /// with 255 for the webview and Windows ignores it for the window.
    fn from(rgb: CaptionRgb) -> Self {
        Self(rgb.red, rgb.green, rgb.blue, 0xff)
    }
}

/// Accept `#rgb`–`#rrggbbaa` and `rgb()`/`rgba()` with numeric, comma- or
/// space-separated components. This is the *superset* of upstream's
/// `preload-windows.ts` output that [`parse_css_color`] can reduce: the
/// renderer always sends canvas-normalized `rgba(r, g, b, a)`.
fn is_css_color(value: &str) -> bool {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = value.to_ascii_lowercase();
    let body = if let Some(rest) = lower.strip_prefix("rgba(") {
        rest
    } else if let Some(rest) = lower.strip_prefix("rgb(") {
        rest
    } else {
        return false;
    };
    let Some(inner) = body.strip_suffix(')') else {
        return false;
    };
    if inner.is_empty() || inner.len() > 64 {
        return false;
    }
    inner
        .split([',', ' '])
        .filter(|part| !part.is_empty())
        .all(|part| {
            let numeric = part
                .strip_suffix('%')
                .unwrap_or(part)
                .strip_suffix("deg")
                .unwrap_or(part.strip_suffix('%').unwrap_or(part));
            !numeric.is_empty()
                && numeric
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '.' || c == '-')
                && numeric.parse::<f64>().is_ok()
        })
}

/// One `rgb()` channel: `0`–`255`, or `0`–`100` as a percentage. `deg` and any
/// other accepted-but-unsupported unit returns `None`.
fn color_channel(part: &str) -> Option<u8> {
    let (number, full_scale) = match part.strip_suffix('%') {
        Some(number) => (number, 100.0),
        None => (part, 255.0),
    };
    let value: f64 = number.parse().ok()?;
    if !value.is_finite() || !(0.0..=full_scale).contains(&value) {
        return None;
    }
    Some((value / full_scale * 255.0).round() as u8)
}

/// Reduce one accepted CSS colour to the channels the native frame paints.
/// Alpha is deliberately dropped: the frame is opaque.
fn parse_css_color(value: &str) -> Option<CaptionRgb> {
    if !is_css_color(value) {
        return None;
    }
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let pairs = if hex.len() <= 4 {
            hex.chars()
                .flat_map(|digit| [digit, digit])
                .collect::<String>()
        } else {
            hex.to_string()
        };
        let byte = |index: usize| u8::from_str_radix(pairs.get(index * 2..index * 2 + 2)?, 16).ok();
        return Some(CaptionRgb {
            red: byte(0)?,
            green: byte(1)?,
            blue: byte(2)?,
        });
    }
    let lower = value.to_ascii_lowercase();
    let inner = lower
        .strip_prefix("rgba(")
        .or_else(|| lower.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts = inner
        .split([',', ' '])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 3 {
        return None;
    }
    Some(CaptionRgb {
        red: color_channel(parts[0])?,
        green: color_channel(parts[1])?,
        blue: color_channel(parts[2])?,
    })
}

/// Accept the BCP 47 subset upstream also accepts (`main.ts:993`).
fn is_language_tag(value: &str) -> bool {
    if value.is_empty() || value.len() > 35 {
        return false;
    }
    let mut parts = value.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    if primary.is_empty() || !primary.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    parts.all(|part| {
        !part.is_empty() && part.len() <= 8 && part.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

impl CaptionPalette {
    /// Validate one renderer measurement.
    pub fn parse(language: &str, fill: &str, symbol: &str) -> Result<Self, CaptionPaletteError> {
        if !is_language_tag(language) {
            return Err(CaptionPaletteError::Language);
        }
        if !is_css_color(fill) || !is_css_color(symbol) {
            return Err(CaptionPaletteError::Color);
        }
        Ok(Self {
            language: language.to_string(),
            fill: fill.trim().to_string(),
            symbol: symbol.trim().to_string(),
        })
    }

    /// Parse the positional `[language, fill, symbol]` report the probe sends
    /// (`preload-windows.ts:40-45` sends exactly these three values).
    ///
    /// A missing or malformed element is a rejection, not a default. Upstream
    /// drops the language and still applies the colours; the port has no
    /// language consumer (the caption labels come from the Rust dictionary), and
    /// the client sets `document.documentElement.lang` during boot — the
    /// probe's `lang` observer re-reports as soon as it does.
    pub fn from_json(value: &serde_json::Value) -> Result<Self, CaptionPaletteError> {
        let report = value
            .as_array()
            .and_then(|values| (values.len() == 3).then(|| &values[..]))
            .ok_or(CaptionPaletteError::Language)?;
        let text = |index: usize| report[index].as_str().unwrap_or_default();
        Self::parse(text(0), text(1), text(2))
    }

    /// The colour the native caption frame takes on for this measurement.
    ///
    /// `None` where the port installs no port-owned caption frame: only Windows
    /// runs the caption chrome, and the frameless window is the only surface
    /// with a native frame to paint. `None` also when the measured fill is an
    /// accepted colour the native layer cannot express (`deg`), which leaves
    /// the last applied frame in place.
    pub fn native_caption_frame(&self) -> Option<tauri::webview::Color> {
        if !cfg!(target_os = "windows") {
            return None;
        }
        parse_css_color(&self.fill).map(tauri::webview::Color::from)
    }
}

/// Fallback caption fill before the renderer reports its measured palette
/// (`chromeFallbackFill`, `main.ts:184-186`).
pub fn chrome_fallback_fill(dark: bool) -> &'static str {
    if dark {
        "#1b1b1c"
    } else {
        "#f9fafb"
    }
}

/// Fallback caption symbol colour (`main.ts:212`).
pub fn chrome_fallback_symbol(dark: bool) -> &'static str {
    if dark {
        "#f9fafb"
    } else {
        "#0f1115"
    }
}

/// The native frame colour a window shows before the renderer has reported a
/// measurement (`titleBarOverlay.color`, `main.ts:211`).
///
/// Pass it to the window builder — `.background_color(chrome_f/
/// chrome_fallback_background(theme))` — so the frameless window and the WebView2
/// backing are never the platform's white while the client boots.
///
/// `Theme::System` resolves to the light swatch: upstream reads
/// `nativeTheme.shouldUseDarkColors` here, and the port has no equivalent query
/// before the first document loads. The first report replaces this value, so
/// the window never stays on the wrong swatch.
///
/// **Open parity gap, not a solved one.** A launch whose theme source is
/// `system` on a dark OS shows the light swatch for the length of the client
/// boot, where upstream shows the OS scheme immediately. Closing it needs a
/// native system-colour query at window creation; that is not a
/// `shell_caption_palette` concern and the `windows` feature set this crate
/// enables does not include the registry API such a read would use, so it stays
/// recorded here rather than silently approximated.
pub fn chrome_fallback_background(theme: Theme) -> tauri::webview::Color {
    let fill = chrome_fallback_fill(theme == Theme::Dark);
    match parse_css_color(fill) {
        Some(rgb) => rgb.into(),
        // Both swatches are `#rrggbb` literals, and the swatch test pins that
        // they parse; this arm only keeps the signature total.
        None => tauri::webview::Color(0xf9, 0xfa, 0xfb, 0xff),
    }
}

/// The sender facts a caption report has to prove, taken from the webview that
/// dispatched the invoke — never from the window the report is applied to.
#[derive(Debug, Clone, Copy)]
pub struct CaptionPaletteSender<'a> {
    /// Label of the sender's window.
    pub window_label: &'a str,
    /// Label of the sender's webview.
    pub webview_label: &'a str,
    /// The sender's current URL.
    pub url: &'a url::Url,
}

/// Whether these sender facts identify the owned application view at this
/// launch's gateway origin.
///
/// A native guest is a *sibling webview inside the same window*, so window
/// ownership proves nothing about who reported. Both the window and the webview
/// label must be the application view and the sender's current URL must still be
/// the owned origin — the same rule the process-wide IPC gate applies
/// (`security::authorized_invoke`), restated here so this command does not
/// depend on a gate it does not own.
pub fn is_owned_caption_palette_sender(
    origin: &crate::security::OwnedAppOrigin,
    sender: CaptionPaletteSender<'_>,
) -> bool {
    origin.allows_sender(sender.window_label, sender.webview_label, sender.url)
}

/// `shell_caption_palette`: the port's `windowsAppearance` handler, called by
/// the probe in [`caption_palette_probe_script`] with the positional
/// `[lang, fill, symbol]` triple upstream sends.
///
/// `webview` is the invoking webview: Tauri's `CommandArg` impl for `Webview`
/// resolves `command.message.webview()` (tauri-2.11.6 `webview/mod.rs:2330`), so
/// this argument *is* the sender and not the window that hosts it.
#[tauri::command]
pub fn shell_caption_palette(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    palette: serde_json::Value,
) -> Result<(), DshError> {
    apply_caption_palette(&app, &webview, &palette)
}

/// Apply one renderer caption report to the owned application window.
///
/// Upstream passes the pair to `mainWindow.setTitleBarOverlay`; the frameless
/// port applies the fill to the two native surfaces a frameless window actually
/// paints — the window's erase background (tao's `WM_ERASEBKGND` fill) and the
/// WebView2 backing (`ICoreWebView2Controller2::SetDefaultBackgroundColor`) —
/// both through `WebviewWindow::set_background_color`, which the pinned runtime
/// marshals to the UI thread when the caller is off it.
///
/// Two independent facts must hold, in this order:
///
/// 1. the **sender** — the webview that invoked the command — is the owned
///    application view at this launch's origin
///    ([`is_owned_caption_palette_sender`]);
/// 2. the **recipient** — the `main` window the frame is painted on — is the
///    owned application window ([`crate::is_owned_application_window`]).
///
/// Sender first, before the report is parsed, so an unauthorized caller learns
/// nothing about what a valid measurement looks like.
pub fn apply_caption_palette(
    app: &tauri::AppHandle,
    sender: &tauri::Webview,
    report: &serde_json::Value,
) -> Result<(), DshError> {
    crate::policy_composition::require_normal(app)?;
    let Some(origin) = sender.try_state::<crate::security::OwnedAppOrigin>() else {
        return Err(DshError::invalid_argument(
            "palette",
            "no owned origin is registered for the reporting webview",
        ));
    };
    let Ok(url) = sender.url() else {
        return Err(DshError::invalid_argument(
            "palette",
            "the reporting webview's current URL could not be read",
        ));
    };
    let host = sender.window();
    let facts = CaptionPaletteSender {
        window_label: host.label(),
        webview_label: sender.label(),
        url: &url,
    };
    if !is_owned_caption_palette_sender(&origin, facts) {
        return Err(DshError::invalid_argument(
            "palette",
            "caption palettes are accepted from the owned application view only",
        ));
    }
    let palette = CaptionPalette::from_json(report)
        .map_err(|error| DshError::invalid_argument("palette", error.to_string()))?;
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        tracing::debug!(
            caption_palette_dropped = true,
            reason = "no_application_window"
        );
        return Ok(());
    };
    if !crate::is_owned_application_window(&window) {
        return Err(DshError::invalid_argument(
            "palette",
            "the application window is not at the owned origin",
        ));
    }
    match palette.native_caption_frame() {
        Some(color) => window
            .set_background_color(Some(color))
            .map_err(|error| DshError::other("window_caption_frame", error.to_string()))?,
        None => tracing::debug!(
            caption_frame_paint_skipped = true,
            "no native caption frame applies to this measurement"
        ),
    }
    tracing::debug!(
        caption_frame_applied = true,
        language = %palette.language,
        "measured caption palette applied to the native frame"
    );
    Ok(())
}

/// The caption menu labels the injected Shadow DOM renders, taken from the
/// active shell dictionary (`preload-menu.ts:98-103`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptionMenuLabels {
    /// `role="menubar"` accessible name (`messages.menuBar`).
    pub menubar: String,
    /// First button (`messages.application`).
    pub application: String,
    /// Second button (`messages.edit`).
    pub edit: String,
}

/// Build the caption labels for one locale. The two button labels come from the
/// same dictionary the native menus and dialogs use, so a locale switch changes
/// the caption and the dialogs together.
pub fn caption_menu_labels(locale: LocaleId) -> CaptionMenuLabels {
    let messages = crate::state::messages(locale);
    CaptionMenuLabels {
        menubar: crate::shell_messages::messages(locale).menu_bar.to_string(),
        application: messages.application.to_string(),
        edit: messages.edit.to_string(),
    }
}
/// Script that updates the labels of an already mounted caption menubar.
///
/// The Rust dictionary is the single source of the labels: this script never
/// derives copy of its own.
pub fn label_sync_script(labels: &CaptionMenuLabels) -> String {
    let bar = serde_json::to_string(&labels.menubar).unwrap_or_else(|_| "\"\"".to_string());
    let application =
        serde_json::to_string(&labels.application).unwrap_or_else(|_| "\"\"".to_string());
    let edit = serde_json::to_string(&labels.edit).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function () {{
  globalThis.__DSH_CAPTION_LABELS__ = {{ menubar: {bar}, application: {application}, edit: {edit} }};
  var host = document.getElementById({host});
  if (!host || !host.shadowRoot) return false;
  var bar = host.shadowRoot.querySelector('[role=menubar]');
  if (bar) bar.setAttribute('aria-label', {bar});
  var buttons = host.shadowRoot.querySelectorAll('button');
  if (buttons.length > 0) buttons[0].textContent = {application};
  if (buttons.length > 1) buttons[1].textContent = {edit};
  return true;
}})();"#,
        host = serde_json::to_string(MENU_HOST_ID).unwrap_or_else(|_| "\"\"".to_string()),
        bar = bar,
        application = application,
        edit = edit,
    )
}

/// Push the active locale's caption labels into the mounted menubar.
///
/// Called on every `shell_locale_apply` (and at startup). A window without the
/// injected menubar is left alone: `label_sync_script` returns `false` and the
/// evaluation is a no-op, so this is safe on every platform.
pub fn sync_caption_labels(app: &tauri::AppHandle, locale: LocaleId) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || sync_caption_labels_on_ui(&handle, locale));
}
fn sync_caption_labels_on_ui(app: &tauri::AppHandle, locale: LocaleId) {
    if crate::policy_composition::require_normal(app).is_err() {
        return;
    }
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !crate::is_owned_application_window(&window) {
        return;
    }
    let labels = caption_menu_labels(locale);
    if let Err(error) = window.eval(label_sync_script(&labels)) {
        tracing::debug!(
            caption_label_sync_failed = true,
            error_kind = %error,
            "caption menu labels could not be synchronized"
        );
    }
}

/// The caption menubar, mounted only `platform_id() == "win32"` and only after
/// the application frame renders its `[data-shell-overlay]` seat
/// (`preload-menu.ts:89-97`).
const CAPTION_MENU_SCRIPT: &str = r#"
    (function () {
      if (document.getElementById('dsh-native-menu')) return;
      var host = document.createElement('div');
      host.id = 'dsh-native-menu';
      host.dataset.windowsMenu = '';
      var shadow = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = [
        ':host { position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px);',
        '  z-index: 1100; height: var(--dsh-windows-titlebar-height); display: flex;',
        '  align-items: center; font-family: var(--dsw-font-family);',
        '  -webkit-app-region: no-drag; }',
        '[role=menubar] { display: flex; gap: 2px; }',
        'button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px;',
        '  background: transparent; color: var(--dsw-alias-label-secondary);',
        '  font: inherit; font-size: 14px; cursor: default; }',
        'button:hover, button[aria-expanded=true] { background: var(--dsw-alias-interactive-bg-hover);',
        '  color: var(--dsw-alias-label-primary); }',
        'button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary);',
        '  outline-offset: -2px; }',
        ":host-context(html[data-input-modality='pointer']) button:focus-visible { outline-color: transparent; }",
      ].join('\n');
      var labels = globalThis.__DSH_CAPTION_LABELS__ || { menubar: 'Menu bar', application: 'Application', edit: 'Edit' };
      var bar = document.createElement('div');
      bar.setAttribute('role', 'menubar');
      bar.setAttribute('aria-label', labels.menubar);
      var restoreEditor = function () {};
      var rememberEditor = function (event) {
        var target = event.composedPath()[0];
        if (!(target instanceof HTMLElement) || target === host || shadow.contains(target)) return;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)
          && !target.matches('[contenteditable="true"]')) return;
        var selection = document.getSelection();
        var ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, function (_, i) {
          return selection.getRangeAt(i).cloneRange();
        });
        var input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target : undefined;
        var start = input && input.selectionStart;
        var end = input && input.selectionEnd;
        var direction = input && input.selectionDirection;
        restoreEditor = function () {
          if (!target.isConnected) return;
          target.focus({ preventScroll: true });
          if (input !== undefined && start != null && end != null) {
            input.setSelectionRange(start, end, direction == null ? undefined : direction);
          } else if (selection !== null && ranges.length > 0) {
            selection.removeAllRanges();
            for (var index = 0; index < ranges.length; index += 1) selection.addRange(ranges[index]);
          }
        };
      };
      document.addEventListener('focusout', rememberEditor, true);
      var open = function (button, name) {
        return function () {
          if (button.getAttribute('aria-expanded') === 'true') return;
          var rect = button.getBoundingClientRect();
          button.setAttribute('aria-expanded', 'true');
          if (document.activeElement === host) restoreEditor();
          var invoke = window.__TAURI_INTERNALS__;
          var request = invoke && invoke.invoke
            ? invoke.invoke('shell_caption_menu', {
                name: name, x: rect.left, y: rect.bottom,
              })
            : Promise.resolve();
          Promise.resolve(request).catch(function () {}).then(function () {
            button.setAttribute('aria-expanded', 'false');
          });
        };
      };
      var buttons = ['application', 'edit'].map(function (name, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = labels[name];
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.tabIndex = index === 0 ? 0 : -1;
        button.addEventListener('pointerdown', function (event) { event.preventDefault(); });
        button.addEventListener('mousedown', function (event) { event.preventDefault(); });
        button.addEventListener('click', open(button, name));
        button.addEventListener('keydown', function (event) {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            var next = buttons[index === 0 ? 1 : 0];
            button.tabIndex = -1;
            next.tabIndex = 0;
            next.focus();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            open(button, name)();
          }
        });
        bar.append(button);
        return button;
      });
      shadow.append(style, bar);
      var mount = function () {
        if (document.querySelector('[data-shell-overlay]') === null) return;
        document.body.append(host);
        observer.disconnect();
      };
      var observer = new MutationObserver(mount);
      observer.observe(document.body, { childList: true, subtree: true });
      mount();
      window.addEventListener('pagehide', function () {
        observer.disconnect();
        document.removeEventListener('focusout', rememberEditor, true);
        host.remove();
      }, { once: true });
    })();
"#;

/// The resize-grip layer for the frameless Windows window. It is a separate
/// fixed layer so the caption row itself stays inside the client's drag region
/// instead of being covered by an overlay. Every id and direction comes from
/// [`GRIP_LAYER_ID`] and [`GRIP_DIRECTIONS`], so the script and the shell's
/// resize command cannot drift apart.
fn resize_grip_script() -> String {
    let encode = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    // The stylesheet interpolates the bare id into a CSS selector; only the two
    // JavaScript string positions take the JSON-encoded form.
    let layer = GRIP_LAYER_ID;
    let layer_value = encode(GRIP_LAYER_ID);
    let grips = GRIP_DIRECTIONS
        .iter()
        .map(|(suffix, direction)| format!("[{}, {}]", encode(suffix), encode(direction)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"
    (function () {{
      if (document.getElementById({layer_value})) return;
      var style = document.createElement('style');
      style.textContent = [
        '#{layer} {{ position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }}',
        '#{layer} .dsh-grip {{ position: fixed; pointer-events: auto; background: transparent; }}',
        '#{layer} .dsh-n, #{layer} .dsh-s {{ left: 10px; right: 10px; height: 6px; cursor: ns-resize; }}',
        '#{layer} .dsh-n {{ top: 0; }} #{layer} .dsh-s {{ bottom: 0; }}',
        '#{layer} .dsh-e, #{layer} .dsh-w {{ top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }}',
        '#{layer} .dsh-e {{ right: 0; }} #{layer} .dsh-w {{ left: 0; }}',
        '#{layer} .dsh-ne, #{layer} .dsh-nw, #{layer} .dsh-se, #{layer} .dsh-sw {{',
        '  width: 12px; height: 12px; }}',
        '#{layer} .dsh-ne {{ top: 0; right: 0; cursor: nesw-resize; }}',
        '#{layer} .dsh-nw {{ top: 0; left: 0; cursor: nwse-resize; }}',
        '#{layer} .dsh-se {{ bottom: 0; right: 0; cursor: nwse-resize; }}',
        '#{layer} .dsh-sw {{ bottom: 0; left: 0; cursor: nesw-resize; }}',
      ].join('\n');
      document.documentElement.appendChild(style);
      var layer = document.createElement('div');
      layer.id = {layer_value};
      layer.innerHTML = [{grips}].map(function (grip) {{
        return '<div class="dsh-grip dsh-' + grip[0] + '" data-resize="' + grip[1] + '"></div>';
      }}).join('');
      document.documentElement.appendChild(layer);
      layer.addEventListener('pointerdown', function (event) {{
        var grip = event.target.closest('[data-resize]');
        if (!grip) return;
        event.preventDefault();
        var invoke = window.__TAURI_INTERNALS__;
        if (invoke && invoke.invoke) {{
          invoke.invoke('shell_window_resize_dragging', {{
            direction: grip.dataset.resize,
          }}).catch(function () {{}});
        }}
      }});
      window.addEventListener('pagehide', function () {{
        layer.remove();
        style.remove();
      }}, {{ once: true }});
    }})();
"#
    )
}

/// The caption palette probe (`preload-windows.ts:21-58`).
///
/// One hidden span carrying [`CAPTION_PROBE_CSS`] resolves both colours through
/// the client's own tokens, one canvas normalizes them to `rgba()`, and every
/// changed measurement both repaints the caption row (the port's DOM stand-in
/// for upstream's operating-system caption) and reports
/// `[lang, fill, symbol]` to [`apply_caption_palette`]. `nothing here
/// interpolates anything but the JSON-encoded constant above.
fn caption_palette_probe_script() -> String {
    let encode = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
    (function () {{
      if (globalThis.__DSH_CAPTION_PALETTE__) return;
      globalThis.__DSH_CAPTION_PALETTE__ = true;
      var install = function () {{
        var root = document.documentElement;
        var probe = document.createElement('span');
        probe.style.cssText = {probe_css};
        document.body.appendChild(probe);
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        var context = canvas.getContext('2d', {{ willReadFrequently: true }});
        if (!context) return;
        var nativeColor = function (color) {{
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          var data = context.getImageData(0, 0, 1, 1).data;
          return 'rgba(' + data[0] + ', ' + data[1] + ', ' + data[2] + ', ' + (data[3] / 255) + ')';
        }};
        var previous = '';
        var send = function () {{
          var style = getComputedStyle(probe);
          var fill = nativeColor(style.backgroundColor);
          var symbol = nativeColor(style.color);
          // The command argument is the array itself. `palette` arrives as a
          // `serde_json::Value`, so handing over the serialized form would
          // arrive as `Value::String` and be refused. The serialized text is
          // only the change key.
          var report = [root.lang, fill, symbol];
          var values = JSON.stringify(report);
          if (values === previous) return;
          previous = values;
          root.style.setProperty('--dsh-caption-fill', fill);
          root.style.setProperty('--dsh-caption-symbol', symbol);
          var invoke = window.__TAURI_INTERNALS__;
          if (invoke && invoke.invoke) {{
            invoke.invoke({command}, {{ palette: report }}).then(function () {{}}, function (error) {{
              // Report through the console bridge: a refused palette must be
              // observable, not swallowed by an empty catch.
              console.error('dsh caption palette report refused', error);
            }});
          }}
        }};
        var observer = new MutationObserver(send);
        observer.observe(root, {{ attributes: true, attributeFilter: ['lang'] }});
        observer.observe(document.body, {{ attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] }});
        observer.observe(document.head, {{ childList: true, subtree: true, characterData: true }});
        document.head.addEventListener('load', send, true);
        window.addEventListener('pagehide', function () {{
          observer.disconnect();
          probe.remove();
          document.head.removeEventListener('load', send, true);
        }}, {{ once: true }});
        send();
      }};
      if (document.body) install();
      else window.addEventListener('DOMContentLoaded', install, {{ once: true }});
    }})();
"#,
        probe_css = encode(CAPTION_PROBE_CSS),
        command = encode(CAPTION_PALETTE_COMMAND),
    )
}

/// The caption root marker and the pre-measurement palette
/// (`preload-windows.ts:9-16` `mark()`, plus the fallback swatches upstream
/// gives `titleBarOverlay`, `main.ts:211-212`).
///
/// This runs before the caption chrome element exists so the first paint of the
/// caption row already resolves `--dsh-caption-fill`.
///
/// The dark decision uses, in strict precedence:
///
/// 1. `data-ds-theme-source` on the root, when it is exactly `light` or `dark`
///    — the setting the user chose, published by `shell_theme_set`;
/// 2. the client's `data-ds-dark-theme` **presence toggle** on `body`
///    (`document.body.toggleAttribute`, see the reference DOM snapshot) — what
///    the client actually painted, which outranks the system scheme even while
///    the source reads `system`;
/// 3. `prefers-color-scheme` — only when neither marker answers.
///
/// **Known gap.** The toggle's *absence* cannot distinguish "the client painted
/// light" from "the client has not painted yet", so a light theme on a dark OS
/// shows the dark swatch until the probe's first measurement. Every value here
/// is provisional by construction: the probe replaces both properties with the
/// client's resolved tokens as soon as `document.body` exists.
pub fn windows_caption_root_script() -> String {
    let encode = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function () {{
  var root = document.documentElement;
  if (!root) return;
  root.dataset.windowsTitlebar = '';
  root.style.setProperty('--dsh-windows-titlebar-height', '{height}px');
  var source = root.getAttribute('data-ds-theme-source');
  var marker = document.body !== null && document.body.hasAttribute('data-ds-dark-theme');
  var dark = source === 'dark'
    || (source !== 'light' && (marker || window.matchMedia('(prefers-color-scheme: dark)').matches));
  root.style.setProperty('--dsh-caption-fill', dark ? {dark_fill} : {light_fill});
  root.style.setProperty('--dsh-caption-symbol', dark ? {dark_symbol} : {light_symbol});
}})();"#,
        height = WINDOWS_TITLEBAR_HEIGHT,
        dark_fill = encode(chrome_fallback_fill(true)),
        light_fill = encode(chrome_fallback_fill(false)),
        dark_symbol = encode(chrome_fallback_symbol(true)),
        light_symbol = encode(chrome_fallback_symbol(false)),
    )
}

/// Assemble the capture-side pieces for the initialization script: the caption
/// root marker and fallback palette, the resize grips, the caption menubar, and
/// the palette probe. Kept as one function so the lead's `lib.rs` integration
/// is a single call.
///
/// The root script is idempotent — it sets four properties on the same element
/// every time it runs — so it is safe here even though `lib.rs` also runs
/// [`windows_caption_root_script`] at marker time, before this bundle waits for
/// `document.body`.
pub fn windows_caption_scripts() -> String {
    let mut script = windows_caption_root_script();
    script.push_str(&resize_grip_script());
    script.push_str(CAPTION_MENU_SCRIPT);
    script.push_str(&caption_palette_probe_script());
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_labels_come_from_the_shell_dictionary() {
        let en = caption_menu_labels(LocaleId::En);
        assert_eq!(en.application, "Application");
        assert_eq!(en.edit, "Edit");
        assert_eq!(en.menubar, "Application menu");
        let zh = caption_menu_labels(LocaleId::Zh);
        assert_eq!(zh.application, "应用");
        assert_eq!(zh.edit, "编辑");
        assert_eq!(zh.menubar, "应用菜单");
    }

    #[test]
    fn label_sync_script_carries_the_localized_copy_verbatim() {
        let zh = caption_menu_labels(LocaleId::Zh);
        let script = label_sync_script(&zh);
        assert!(script.contains("\"应用菜单\""), "{script}");
        assert!(script.contains("\"应用\""), "{script}");
        assert!(script.contains("\"编辑\""), "{script}");
        // The host id is JSON-encoded, so a host name can never break out of the
        // string literal.
        assert!(script.contains("\"dsh-native-menu\""), "{script}");
    }

    #[test]
    fn caption_palette_accepts_canvas_normalized_colors() {
        let palette =
            CaptionPalette::parse("zh-CN", "rgba(27, 27, 28, 1)", "rgba(249, 250, 251, 1)")
                .expect("valid palette");
        assert_eq!(palette.language, "zh-CN");
        assert_eq!(palette.fill, "rgba(27, 27, 28, 1)");
    }

    #[test]
    fn caption_palette_rejects_injection_attempts_and_malformed_colors() {
        for (language, fill, symbol) in [
            ("en", "red; background: url(evil)", "rgba(1,2,3,1)"),
            ("en", "rgba(1,2,3)", "rgba(1,2,3,1); } evil {"),
            ("en\"); evil(); (\"", "rgba(1,2,3,1)", "rgba(1,2,3,1)"),
            ("en", "#12", "rgba(1,2,3,1)"),
            ("en-US-", "rgba(1,2,3,1)", "rgba(1,2,3,1)"),
            ("", "rgba(1,2,3,1)", "rgba(1,2,3,1)"),
        ] {
            assert!(
                CaptionPalette::parse(language, fill, symbol).is_err(),
                "{language} / {fill} / {symbol} must be rejected"
            );
        }
    }

    #[test]
    fn caption_palette_reads_the_positional_renderer_report() {
        let report = serde_json::json!(["en-US", "rgba(249, 250, 251, 1)", "#0f1115",]);
        let palette = CaptionPalette::from_json(&report).expect("valid report");
        assert_eq!(palette.language, "en-US");
        assert_eq!(palette.symbol, "#0f1115");
        // A missing element is a rejection, not a default: the probe never sends
        // a partial measurement, and an empty slot must not reach the frame.
        assert!(CaptionPalette::from_json(&serde_json::json!(["en"])).is_err());
        assert!(CaptionPalette::from_json(&serde_json::json!({
            "language": "en",
            "fill": "rgba(1,2,3,1)",
            "symbol": "rgba(1,2,3,1)",
        }))
        .is_err());
    }

    #[test]
    fn caption_fallback_matches_the_reference_swatches() {
        assert_eq!(chrome_fallback_fill(false), "#f9fafb");
        assert_eq!(chrome_fallback_fill(true), "#1b1b1c");
        assert_eq!(chrome_fallback_symbol(false), "#0f1115");
        assert_eq!(chrome_fallback_symbol(true), "#f9fafb");
        assert_eq!(WINDOWS_TITLEBAR_HEIGHT, 40);
        // Both swatches parse, so the creation-time frame never falls back to
        // the hard-coded light colour in `chrome_fallback_background`.
        assert_eq!(
            chrome_fallback_background(Theme::Dark),
            tauri::webview::Color(0x1b, 0x1b, 0x1c, 0xff)
        );
        assert_eq!(
            chrome_fallback_background(Theme::Light),
            tauri::webview::Color(0xf9, 0xfa, 0xfb, 0xff)
        );
        // System has no native query before the first document loads; it starts
        // on the light swatch and the first measurement replaces it.
        assert_eq!(
            chrome_fallback_background(Theme::System),
            chrome_fallback_background(Theme::Light)
        );
    }

    #[test]
    fn measured_fill_becomes_the_native_frame_color() {
        let palette = CaptionPalette::parse("en", "rgba(27, 27, 28, 1)", "#f9fafb").expect("valid");
        let expected = if cfg!(target_os = "windows") {
            Some(tauri::webview::Color(27, 27, 28, 0xff))
        } else {
            None
        };
        assert_eq!(palette.native_caption_frame(), expected);
    }

    #[test]
    fn native_frame_color_reduces_hex_percent_and_rejects_unsupported_units() {
        assert_eq!(
            parse_css_color("#f9fafb"),
            Some(CaptionRgb {
                red: 0xf9,
                green: 0xfa,
                blue: 0xfb
            })
        );
        assert_eq!(
            parse_css_color("#FFF"),
            Some(CaptionRgb {
                red: 0xff,
                green: 0xff,
                blue: 0xff
            })
        );
        // The trailing alpha of `#rrggbbaa` is dropped: the frame is opaque.
        assert_eq!(
            parse_css_color("#1b1b1c00"),
            Some(CaptionRgb {
                red: 0x1b,
                green: 0x1b,
                blue: 0x1c
            })
        );
        assert_eq!(
            parse_css_color("rgb(100%, 0%, 50%)"),
            Some(CaptionRgb {
                red: 255,
                green: 0,
                blue: 128
            })
        );
        // `is_css_color` accepts these; the native layer cannot express them, so
        // the frame keeps its last applied colour instead of guessing.
        assert_eq!(parse_css_color("hsl(0deg, 0%, 0%)"), None);
        assert_eq!(parse_css_color("rgb(300, 0, 0)"), None);
        assert_eq!(parse_css_color("rgb(1 2)"), None);
    }

    #[test]
    fn caption_root_script_marks_the_titlebar_and_seeds_the_fallback_palette() {
        let script = windows_caption_root_script();
        // The two DOM markers the shared client CSS scopes on.
        assert!(
            script.contains("root.dataset.windowsTitlebar = ''"),
            "{script}"
        );
        assert!(script.contains("--dsh-windows-titlebar-height"), "{script}");
        assert!(script.contains("40px"), "{script}");
        // The pre-measurement palette is the reference's fallback swatches, and
        // the dark decision follows the client marker before the system scheme.
        for swatch in [
            chrome_fallback_fill(true),
            chrome_fallback_fill(false),
            chrome_fallback_symbol(true),
            chrome_fallback_symbol(false),
        ] {
            assert!(
                script.contains(&format!("\"{swatch}\"")),
                "{swatch} missing"
            );
        }
        assert!(script.contains("data-ds-theme-source"), "{script}");
        assert!(script.contains("data-ds-dark-theme"), "{script}");
        assert!(script.contains("prefers-color-scheme: dark"), "{script}");
        // Precedence is explicit in the emitted text: an explicit root source
        // wins over the body marker, and the body marker wins over the scheme.
        assert!(
            script.contains("var dark = source === 'dark'\n    || (source !== 'light' && (marker || window.matchMedia('(prefers-color-scheme: dark)').matches));"),
            "{script}"
        );
    }

    #[test]
    fn caption_palette_accepts_only_the_owned_application_view_as_sender() {
        let origin = crate::security::OwnedAppOrigin::from_gateway_url(
            &url::Url::parse("http://127.0.0.1:31991/?token=secret").expect("gateway url"),
        )
        .expect("owned origin");
        let owned = url::Url::parse("http://127.0.0.1:31991/app/workspace").expect("owned url");
        let foreign =
            url::Url::parse("http://127.0.0.1:31992/app/workspace").expect("other launch");
        let sender = |window: &'static str, webview: &'static str, url: &url::Url| {
            is_owned_caption_palette_sender(
                &origin,
                CaptionPaletteSender {
                    window_label: window,
                    webview_label: webview,
                    url,
                },
            )
        };
        assert!(sender("main", "main", &owned));
        // A native guest is a sibling webview inside the main window: window
        // ownership alone must not authorize it.
        assert!(!sender("main", "guest-browser-1", &owned));
        assert!(!sender("main", "mandatory-policy", &owned));
        // Another launch's gateway, and a foreign document at this launch's
        // origin, are both refused.
        assert!(!sender("main", "main", &foreign));
        assert!(!sender("other", "main", &owned));
        assert!(!sender(
            "main",
            "main",
            &url::Url::parse("https://127.0.0.1:31991/").unwrap()
        ));
    }

    #[test]
    fn caption_scripts_use_the_upstream_selectors_and_menu_contract() {
        let script = windows_caption_scripts();
        // The caption menubar waits for the AppFrame seat and reads the sidebar's
        // menu offset rather than hardcoding one.
        assert!(script.contains("[data-shell-overlay]"), "{script}");
        assert!(
            script.contains("--dsh-windows-menu-start, 48px"),
            "{script}"
        );
        // The caption popup request uses the port's command name; the withdrawn
        // `windowsMenu` IPC *channel* must not appear (the DOM marker
        // `data-windows-menu` is upstream's and stays).
        assert!(script.contains("shell_caption_menu"), "{script}");
        assert!(!script.contains("'windowsMenu'"), "{script}");
        assert!(!script.contains("windowsMenu,"), "{script}");
        assert!(script.contains("host.dataset.windowsMenu = ''"), "{script}");
    }

    #[test]
    fn the_grip_layer_is_generated_from_the_grip_constants() {
        let script = windows_caption_scripts();
        assert!(script.contains(&format!("\"{GRIP_LAYER_ID}\"")), "{script}");
        for (suffix, direction) in GRIP_DIRECTIONS {
            assert!(
                script.contains(&format!("[\"{suffix}\", \"{direction}\"]")),
                "{suffix}/{direction} missing"
            );
        }
        assert!(script.contains("shell_window_resize_dragging"), "{script}");
        // The stylesheet selectors and the mounted id come from one constant, so
        // a rename cannot leave the layer styled but unaddressable.
        assert!(
            script.contains(&format!("#{GRIP_LAYER_ID} .dsh-grip")),
            "{script}"
        );
        assert!(
            script.contains(&format!("layer.id = \"{GRIP_LAYER_ID}\"")),
            "{script}"
        );
        assert!(
            script.contains(&format!("document.getElementById(\"{GRIP_LAYER_ID}\")")),
            "{script}"
        );
    }

    #[test]
    fn the_palette_probe_measures_both_tokens_and_reports_to_the_native_side() {
        let script = windows_caption_scripts();
        // The probe span carries the reference expression verbatim, JSON-encoded.
        assert!(
            script.contains(&format!("\"{}\"", CAPTION_PROBE_CSS)),
            "{script}"
        );
        assert!(
            script.contains("var(--dsw-specific-sidebar-fill)"),
            "{script}"
        );
        assert!(
            script.contains("var(--dsw-alias-label-primary)"),
            "{script}"
        );
        // Upstream normalizes both colours through a 1x1 canvas before sending.
        assert!(
            script.contains("getContext('2d', { willReadFrequently: true })"),
            "{script}"
        );
        assert!(script.contains("getImageData(0, 0, 1, 1).data"), "{script}");
        // The report is the positional triple `apply_caption_palette` parses.
        assert!(
            script.contains(&format!("\"{CAPTION_PALETTE_COMMAND}\"")),
            "{script}"
        );
        assert!(
            script.contains("var report = [root.lang, fill, symbol];"),
            "{script}"
        );
        // The probe observes the same three sources upstream does.
        assert!(script.contains("attributeFilter: ['lang']"), "{script}");
        assert!(
            script.contains("attributeFilter: ['data-ds-dark-theme', 'style']"),
            "{script}"
        );
        // It repaints the caption row from the same measurement and cannot be
        // installed twice.
        assert!(script.contains("'--dsh-caption-fill'"), "{script}");
        assert!(script.contains("'--dsh-caption-symbol'"), "{script}");
        assert!(
            script.contains("if (globalThis.__DSH_CAPTION_PALETTE__) return;"),
            "{script}"
        );
    }

    /// Regression for the packet that shipped broken: the probe sent its
    /// serialized change key as the command argument, so `palette` arrived as
    /// `Value::String` and the strict parser refused every real measurement. The
    /// rejection was invisible because the invoke was swallowed by an empty
    /// `catch`.
    ///
    /// This executes the producer/consumer contract rather than matching
    /// substrings: the emitted script is parsed for the argument it actually
    /// passes, the value that argument produces is put through the same
    /// serialization the IPC performs, and the strict parser must accept it —
    /// while the serialized string form stays refused.
    #[test]
    fn the_emitted_probe_packet_is_accepted_by_the_strict_parser() {
        let script = caption_palette_probe_script();
        // The argument the emitted script hands to `invoke`.
        let argument = script
            .split("invoke(\"shell_caption_palette\", { palette: ")
            .nth(1)
            .and_then(|rest| rest.split(" })").next())
            .expect("the probe must invoke the palette command");
        assert_eq!(
            argument, "report",
            "the command argument must be the array variable, not the change key"
        );
        // The value that variable holds at the call site.
        let produced = script
            .split("var report = ")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("the probe must build the report array");
        assert_eq!(produced, "[root.lang, fill, symbol]");
        // `values` is the change key only; handing it over is the defect.
        assert!(script.contains("var values = JSON.stringify(report);"));
        assert!(
            !script.contains("{ palette: values }"),
            "the serialized change key must never be the command argument"
        );

        // Now execute the packet through the wire round trip the pinned IPC
        // performs: `serde_json::Value` deserializes whatever the renderer sent.
        let report = serde_json::json!(["en-US", "rgba(27, 27, 28, 1)", "rgba(249, 250, 251, 1)"]);
        let over_ipc: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&report).expect("serialize"))
                .expect("parse");
        assert!(
            over_ipc.is_array(),
            "the array must survive the wire as an array"
        );
        let palette = CaptionPalette::from_json(&over_ipc).expect("the emitted packet must parse");
        assert_eq!(palette.language, "en-US");
        assert_eq!(palette.fill, "rgba(27, 27, 28, 1)");

        // The previously emitted form is refused, and no coercion rescues it.
        let serialized: serde_json::Value =
            serde_json::json!(serde_json::to_string(&report).expect("serialize"));
        assert!(serialized.is_string());
        assert_eq!(
            CaptionPalette::from_json(&serialized),
            Err(CaptionPaletteError::Language)
        );
        // A refused report is reported, not swallowed.
        assert!(
            script.contains("console.error('dsh caption palette report refused'"),
            "{script}"
        );
        assert!(!script.contains(".catch(function () {})"), "{script}");
    }
}
