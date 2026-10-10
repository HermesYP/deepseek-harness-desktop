//! Bounded main-renderer console capture. This is not a native crash detector:
//! WebView2 process/navigation callbacks are separately required for parity.

use std::sync::Arc;

use dsh_core::error::DshError;
use serde::Deserialize;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsoleEntry {
    source_id: String,
    line: u32,
    message: String,
}

#[tauri::command]
pub async fn shell_renderer_console(
    state: tauri::State<'_, Arc<AppState>>,
    lines: Vec<ConsoleEntry>,
) -> Result<(), DshError> {
    if lines.len() > 32
        || lines
            .iter()
            .any(|entry| entry.source_id.len() > 4096 || entry.message.len() > 32768)
    {
        return Err(DshError::invalid_argument(
            "lines",
            "renderer diagnostic batch exceeds its budget",
        ));
    }
    let mut diagnostics = state.renderer_console.lock().await;
    crate::policy_composition::require_state(&state)?;
    for entry in lines {
        diagnostics.push_console(&entry.source_id, entry.line, &entry.message);
    }
    Ok(())
}

/// Main-webview-only initialization. Original console behavior is preserved;
/// best-effort reporting is bounded and never creates a recursive error log.
pub const SCRIPT: &str = r#"(function () {
  if (globalThis.__DSH_RENDERER_CONSOLE__) return;
  Object.defineProperty(globalThis, '__DSH_RENDERER_CONSOLE__', { value: true });
  const pending = [];
  let busy = false;
  let timer = null;
  const clip = value => {
    try { return String(value).slice(0, 8192); } catch (_) { return '[unprintable]'; }
  };
  const flush = () => {
    timer = null;
    if (busy || !pending.length || !globalThis.__TAURI_INTERNALS__) return;
    const lines = pending.splice(0, 32);
    busy = true;
    Promise.resolve().then(() => globalThis.__TAURI_INTERNALS__.invoke('shell_renderer_console', { lines }))
      .catch(() => {}).finally(() => {
        busy = false;
        if (pending.length && timer === null) timer = setTimeout(flush, 100);
      });
  };
  const capture = (message, sourceId = location.origin, line = 0) => {
    if (pending.length === 32) pending.shift();
    pending.push({ sourceId: clip(sourceId).slice(0, 1024), line: Number.isInteger(line) && line >= 0 && line <= 4294967295 ? line : 0, message: clip(message) });
    if (!busy && timer === null) timer = setTimeout(flush, 100);
  };
  const original = console.error;
  console.error = function (...args) {
    try { capture(args.slice(0, 16).map(value => clip(value instanceof Error ? value.stack || value.message : value)).join(' ')); } catch (_) {}
    return Reflect.apply(original, this, args);
  };
  window.addEventListener('error', event => {
    // Avoid retaining full boot URLs and their query credentials as source ids.
    capture(event.error && event.error.stack || event.message || 'Uncaught renderer error', location.origin, event.lineno);
  });
  window.addEventListener('unhandledrejection', event => {
    capture(event.reason instanceof Error ? event.reason.stack || event.reason.message : event.reason);
  });
})();"#;
