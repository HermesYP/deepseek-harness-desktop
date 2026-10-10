//! Native file-path handoff: the `__DSH_HOST_PATHS__` bridge the composer reads
//! to cite dropped/picked/pasted files as `@path` references instead of
//! uploading them.
//!
//! Upstream contract (`_upstream/apps/desktop/src/preload-app.ts:78-83`):
//!
//! ```text
//! contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
//!   pathFor: (file: File) => webUtils.getPathForFile(file),
//! })
//! ```
//!
//! Consumer (`_upstream/packages/client/ui-conversation/src/client/apply.ts:456-485`):
//! the composer calls `pathFor(file)` for every dropped file, treats `''` as
//! "no host path" (the file uploads as before), and additionally consults a
//! `Set<File>` of directory members built from `DataTransferItem.webkitGetAsEntry()`.
//!
//! Why this cannot be a TypeScript shim: `webUtils.getPathForFile` is an
//! Electron-only primitive that reads the drag payload's local path out of the
//! Chromium drag data. A WebView2 `File` object exposes only `name`, `size`,
//! `type` and `lastModified`, so no amount of TypeScript can recover a real
//! absolute path. Faking one (for example joining a configured directory with
//! `file.name`) would cite a path that may not exist and would make the
//! composer send a broken `@mention`. Instead the shell binds the paths it can
//! actually observe:
//!
//!   * a **native OS file drop** on the main window's drag-drop handler
//!     (`WindowEvent::DragDrop`), which carries real absolute paths; the shell
//!     retains the drop's paths and hands them to the page, which decides which
//!     of them become `@path` chips through the same composer intake path used
//!     for `<input type="file">` picks.
//!   * the **directory picker** (`shell_pick_directory`), whose absolute result
//!     is a real path.
//!
//! `pathFor(file)` itself answers `''` for an unseen `File` — never a guess —
//! matching upstream's "pasted bytes have no host path and upload as before"
//! behavior.
//!
//! Contract surface of the installed global:
//!
//! ```ts
//! interface DshHostPaths {
//!   pathFor(file: File): string
//!   /** Port extension: adopt the paths of one native drop, in drop order. */
//!   adopt(paths: readonly string[]): void
//!   /** Port extension: the most recent adopted drop, newest last. */
//!   pending(): readonly string[]
//!   /** Port extension: report that the page consumed the pending drop. */
//!   consume(): void
//! }
//! ```
//!
//! `adopt`/`pending`/`consume` are additions, not replacements: `pathFor` keeps
//! upstream's exact signature and answer, so a client that only knows upstream's
//! member still behaves identically (it simply always uploads, which is also
//! what upstream does when the global is absent).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Response of `shell_host_paths` (declared type `HostPaths`).
///
/// Type home: this module, so the port can add a native handoff surface without
/// touching `dsh_core::protocol`'s reviewed union. The shape is the same
/// `{ kind, detail }`-free plain record every other command response uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct HostPaths {
    /// Absolute paths adopted from the most recent native drop, in drop order.
    pub paths: Vec<String>,
    /// Whether the page already imported this batch.
    pub consumed: bool,
}

/// Bounded number of paths adopted from one native drop.
pub const MAX_DROP_PATHS: usize = 256;

/// Bounded length of one adopted path, in characters.
pub const MAX_PATH_CHARS: usize = 4096;

/// A native drop can be correlated only during the document's five-second intake window.
pub const DROP_PATH_TTL: std::time::Duration = std::time::Duration::from_secs(5);

/// Why a candidate drop path was not adopted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathRejection {
    /// The path is empty or whitespace only.
    Empty,
    /// The path is longer than [`MAX_PATH_CHARS`].
    TooLong,
    /// The path is a URI rather than a filesystem path (a dragged browser link).
    NotAPath,
}

/// Build the window's actual path field from dragged text, and no more.
///
/// Kept separate from [`NativePathBridge`] so the drag translation is testable
/// without a window. The result is `None` when the text is not a filesystem
/// path: a dragged web link or a plain-text selection must not become an
/// `@mention`, which the reference would never produce either (its `File` list
/// contains no entry for those payloads).
pub fn path_from_drop_text(text: &str) -> Result<PathBuf, PathRejection> {
    if text.trim().is_empty() {
        return Err(PathRejection::Empty);
    }
    if text.chars().count() > MAX_PATH_CHARS {
        return Err(PathRejection::TooLong);
    }
    // Typed native paths are exact: trailing spaces can be filename bytes.
    // Only quoted shell text permits whitespace outside the quote pair.
    let unquoted = if is_absolute_host_path(text) {
        text
    } else {
        let wrapper = text.trim();
        wrapper
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(text)
    };
    if unquoted.is_empty() {
        return Err(PathRejection::Empty);
    }
    if !is_absolute_host_path(unquoted) || unquoted.contains('\0') || unquoted.contains("://") {
        return Err(PathRejection::NotAPath);
    }
    Ok(PathBuf::from(unquoted))
}

/// The paths adopted from native drops, in adoption order.
///
/// Owned by the shell and shared with the page through the injected
/// `__DSH_HOST_PATHS__` global. The map from a `File` to its path is *not*
/// stored here: the page binds only uniquely named File objects observed in
/// the current DOM drop. Neither basename ordering nor unrelated files supply
/// a reliable native identity.
#[derive(Debug, Default)]
pub struct NativePathBridge {
    adopted: Vec<String>,
    consumed: bool,
    expires: Option<std::time::Instant>,
}

impl NativePathBridge {
    /// Fresh, empty bridge.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adopt the paths of one native drop. Only paths that pass
    /// [`path_from_drop_text`] are kept, in order, and the batch is bounded.
    ///
    /// A drop replaces the previous batch rather than appending: a stale path
    /// must never be attributed to a later `File`.
    pub fn adopt<I, S>(&mut self, candidates: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.adopted.clear();
        self.consumed = false;
        self.expires = Some(std::time::Instant::now() + DROP_PATH_TTL);
        for candidate in candidates {
            if self.adopted.len() >= MAX_DROP_PATHS {
                break;
            }
            if let Ok(path) = path_from_drop_text(candidate.as_ref()) {
                self.adopted.push(path.to_string_lossy().into_owned());
            }
        }
    }

    /// The currently adopted batch.
    pub fn adopted(&self) -> &[String] {
        if self
            .expires
            .is_some_and(|deadline| std::time::Instant::now() < deadline)
        {
            &self.adopted
        } else {
            &[]
        }
    }

    fn expire(&mut self) {
        if self
            .expires
            .is_some_and(|deadline| std::time::Instant::now() >= deadline)
        {
            self.clear();
        }
    }

    /// Whether the page has reported consuming the batch.
    pub fn is_consumed(&self) -> bool {
        self.consumed
    }

    /// Consume and release native metadata. Already-bound DOM File objects
    /// remain addressable only in the document's WeakMap, not through this slot.
    pub fn consume(&mut self) -> bool {
        self.expire();
        let had = !self.adopted.is_empty() && !self.consumed;
        self.adopted.clear();
        self.expires = None;
        self.consumed = true;
        had
    }

    /// Clear the batch (window navigation, `pagehide`).
    pub fn clear(&mut self) {
        self.adopted.clear();
        self.consumed = false;
        self.expires = None;
    }
}

/// JavaScript source of the `__DSH_HOST_PATHS__` global.
///
/// Bind only files observed in one DOM drop to uniquely named native paths.
/// Duplicate basenames and stale batches fail closed: native and DOM ordering
/// are not guaranteed to agree. Picked and pasted files never inherit a path
/// from a previous drop. This does not synthesize DOM files when WebView2's
/// native drop handling suppresses the browser drop event.
pub const HOST_PATHS_SCRIPT: &str = r#"
    (function () {
      if (globalThis.__DSH_HOST_PATHS__ && globalThis.__DSH_HOST_PATHS__.adopt) return;
      var adopted = [];
      var consumed = false;
      var expires = 0;
      var bindings = new WeakMap();
      var names = function (path) {
        var normalized = String(path).replace(/\\/g, '/');
        var parts = normalized.split('/');
        return parts[parts.length - 1] || '';
      };
      var api = {
        pathFor: function (file) {
          if (!file || typeof file.name !== 'string' || file.name === '') return '';
          return bindings.get(file) || '';
        },
        adopt: function (paths) {
          adopted = [];
          consumed = false;
          bindings = new WeakMap();
          expires = Date.now() + 5000;
          if (!Array.isArray(paths)) return;
          for (var index = 0; index < Math.min(paths.length, 256); index += 1) {
            if (typeof paths[index] === 'string' && paths[index] !== '') adopted.push(paths[index]);
          }
          globalThis.dispatchEvent(new CustomEvent('dsh-host-paths', { detail: { paths: adopted.slice() } }));
        },
        pending: function () { return consumed || Date.now() > expires ? [] : adopted.slice(); },
        consume: function () {
          var had = api.pending().length > 0;
          consumed = true;
          return had;
        },
      };
      window.addEventListener('drop', function (event) {
        var paths = api.pending();
        var files = Array.from(event.dataTransfer && event.dataTransfer.files || []).slice(0, 256);
        var pathCounts = new Map();
        var fileCounts = new Map();
        paths.forEach(function (path) {
          var name = names(path);
          pathCounts.set(name, (pathCounts.get(name) || 0) + 1);
        });
        files.forEach(function (file) {
          fileCounts.set(file.name, (fileCounts.get(file.name) || 0) + 1);
        });
        files.forEach(function (file) {
          if (pathCounts.get(file.name) !== 1 || fileCounts.get(file.name) !== 1) return;
          var path = paths.find(function (candidate) { return names(candidate) === file.name; });
          if (path) bindings.set(file, path);
        });
        api.consume();
      }, true);
      globalThis.__DSH_HOST_PATHS__ = api;
      window.addEventListener('pagehide', function () {
        adopted = [];
        consumed = false;
        expires = 0;
        bindings = new WeakMap();
      });
    })();
"#;

/// Script the shell evaluates to hand one native drop's paths to the page.
///
/// The paths are JSON-encoded as one array literal, so a path containing a
/// quote, backslash or newline cannot break out of the script. The call is
/// guarded on the global still existing (the page uninstalls it on `pagehide`).
pub fn adopt_script(paths: &[String]) -> String {
    let payload = serde_json::to_string(paths).unwrap_or_else(|_| "[]".to_string());
    format!("globalThis.__DSH_HOST_PATHS__ && globalThis.__DSH_HOST_PATHS__.adopt({payload});")
}

/// Absolute-path safety check used before a shell-owned path (for example the
/// directory picker's result) is handed to the page: it must be a real
/// filesystem path, not a URI and not a relative fragment.
///
/// `Path::is_absolute` is platform-specific — on Windows it rejects
/// `/home/me/x` and accepts `C:\x`; on Unix it accepts only `/…`. A dragged
/// path may come from either convention, so this checks the shape directly:
/// a drive-letter root, a UNC share, or a POSIX root. A bare drive-relative
/// `C:folder` is *not* absolute and must never be cited as a workspace path.
pub fn is_absolute_host_path(path: &str) -> bool {
    let trimmed = path;
    if trimmed.is_empty() || trimmed.contains("://") {
        return false;
    }
    // POSIX root.
    if trimmed.starts_with('/') {
        return true;
    }
    // UNC share: `\\server\share` (a bare `\\` is not yet a share).
    if let Some(unc_path) = trimmed.strip_prefix("\\\\") {
        return is_complete_unc_or_extended_path(unc_path);
    }
    // Drive root: `C:\…` or `C:/…`.
    let mut chars = trimmed.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), Some(separator))
            if letter.is_ascii_alphabetic() && (separator == '\\' || separator == '/')
    )
}

// The substring following an initial pair of backslashes must name a
// complete UNC share or a supported extended-length filesystem path.
fn is_complete_unc_or_extended_path(path: &str) -> bool {
    if let Some(extended) = path.strip_prefix(r"?\") {
        if let Some(unc) = extended.strip_prefix(r"UNC\") {
            return has_unc_share(unc);
        }
        let mut chars = extended.chars();
        return matches!(
            (chars.next(), chars.next(), chars.next()),
            (Some(letter), Some(':'), Some(separator))
                if letter.is_ascii_alphabetic() && (separator == '\\' || separator == '/')
        );
    }
    has_unc_share(path)
}

fn has_unc_share(path: &str) -> bool {
    let mut components = path.split('\\');
    let valid = |value: Option<&str>| {
        value.is_some_and(|part| {
            !part.is_empty()
                && !matches!(part, "." | ".." | "?")
                && !part.contains('/')
                && !part.contains(':')
        })
    };
    valid(components.next()) && valid(components.next())
}

/// Process-wide host-path bridge.
///
/// One desktop process owns one main window and therefore one drag/drop stream,
/// which is exactly the cardinality upstream's per-preload closure has. A
/// process-level slot (instead of a field on the managed `AppState`) keeps the
/// ownership of this surface inside this module and needs no change to the
/// shared state struct or the shell's setup.
pub fn bridge() -> &'static std::sync::Mutex<NativePathBridge> {
    static BRIDGE: std::sync::OnceLock<std::sync::Mutex<NativePathBridge>> =
        std::sync::OnceLock::new();
    BRIDGE.get_or_init(|| std::sync::Mutex::new(NativePathBridge::new()))
}

/// Adopt one native drop's paths under the process-wide bridge.
pub fn adopt_drop<I, S>(candidates: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    lock_bridge().adopt(candidates);
}

/// Read the process-wide bridge's adopted batch (paths, consumed flag).
pub fn adopted_drop() -> (Vec<String>, bool) {
    let mut bridge = lock_bridge();
    bridge.expire();
    (bridge.adopted().to_vec(), bridge.is_consumed())
}

/// Mark the process-wide pending drop consumed.
pub fn consume_drop() -> bool {
    lock_bridge().consume()
}

/// Clear the process-wide pending drop (navigation / teardown).
pub fn clear_drop() {
    lock_bridge().clear();
}

fn lock_bridge() -> std::sync::MutexGuard<'static, NativePathBridge> {
    // A poisoned lock only means another thread panicked while holding it; the
    // bridge holds no invariant that a panic can break, so the guard is
    // recovered rather than propagated into a `.expect` that would abort the
    // shell on a purely diagnostic path.
    match bridge().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopts_real_absolute_paths_and_rejects_uris() {
        let mut bridge = NativePathBridge::new();
        bridge.adopt([
            "C:\\Users\\me\\notes.txt",
            "https://example.com/page",
            "  ",
            "/home/me/readme.md",
        ]);
        assert_eq!(
            bridge.adopted(),
            &[
                "C:\\Users\\me\\notes.txt".to_string(),
                "/home/me/readme.md".to_string(),
            ]
        );
    }

    #[test]
    fn quoted_windows_drop_paths_are_unquoted() {
        assert_eq!(
            path_from_drop_text("\"C:\\Program Files\\app\\x.txt\"").expect("path"),
            PathBuf::from("C:\\Program Files\\app\\x.txt")
        );
        assert_eq!(
            path_from_drop_text("\"\"").unwrap_err(),
            PathRejection::Empty
        );
        assert_eq!(
            path_from_drop_text("file:///C:/x").unwrap_err(),
            PathRejection::NotAPath
        );
        assert_eq!(
            path_from_drop_text(&"a".repeat(MAX_PATH_CHARS + 1)).unwrap_err(),
            PathRejection::TooLong
        );
    }

    #[test]
    fn unc_paths_require_a_share_and_device_namespaces_are_not_files() {
        for rejected in [
            r"\\",
            r"\\server",
            r"\\server\",
            r"\\server\\share",
            r"\\.\pipe\name",
            r"\\?\pipe\name",
            r"\\?\UNC\server",
            r"\\?\C:relative",
        ] {
            assert!(path_from_drop_text(rejected).is_err(), "{rejected:?}");
        }
        for accepted in [
            r"\\server\share",
            r"\\server\share\file ",
            r"\\?\UNC\server\share\file ",
            r"\\?\C:\drop\file ",
        ] {
            assert_eq!(
                path_from_drop_text(accepted).unwrap(),
                PathBuf::from(accepted)
            );
        }
    }

    #[test]
    fn a_drop_replaces_the_previous_batch() {
        let mut bridge = NativePathBridge::new();
        bridge.adopt(["C:\\a\\one.txt"]);
        bridge.adopt(["C:\\a\\two.txt"]);
        assert_eq!(bridge.adopted(), &["C:\\a\\two.txt".to_string()]);
    }

    #[test]
    fn adoption_is_bounded() {
        let mut bridge = NativePathBridge::new();
        let many: Vec<String> = (0..MAX_DROP_PATHS + 50)
            .map(|index| format!("C:\\drop\\{index}.txt"))
            .collect();
        bridge.adopt(many);
        assert_eq!(bridge.adopted().len(), MAX_DROP_PATHS);
    }

    #[test]
    fn consume_reports_once_and_clears_the_pending_view() {
        let mut bridge = NativePathBridge::new();
        bridge.adopt(["C:\\a\\one.txt"]);
        assert!(bridge.consume());
        assert!(!bridge.consume(), "a second consume reports nothing new");
        assert!(bridge.is_consumed());
        // Only the document WeakMap retains already-bound File identities.
        assert!(bridge.adopted().is_empty());
        bridge.clear();
        assert!(bridge.adopted().is_empty());
        assert!(!bridge.is_consumed());
    }

    #[test]
    fn expired_native_metadata_cannot_be_read_or_consumed() {
        let mut bridge = NativePathBridge::new();
        bridge.adopt(["C:\\a\\one.txt"]);
        bridge.expires = Some(std::time::Instant::now() - std::time::Duration::from_millis(1));
        assert!(bridge.adopted().is_empty());
        assert!(!bridge.consume());
        assert!(bridge.adopted.is_empty(), "expired allocation is released");
        assert!(bridge.expires.is_none());
    }

    #[test]
    fn native_filename_whitespace_is_not_trimmed() {
        for exact in ["C:\\drop\\file ", "/tmp/ file ", "\\\\server\\share\\file "] {
            assert_eq!(path_from_drop_text(exact).unwrap(), PathBuf::from(exact));
        }
        assert_eq!(
            path_from_drop_text("  \"C:\\drop\\file \"  ").unwrap(),
            PathBuf::from("C:\\drop\\file ")
        );
        assert!(path_from_drop_text(" C:\\drop\\file").is_err());
        assert!(path_from_drop_text("C:\\drop\\file\0").is_err());
    }

    #[test]
    fn adopt_script_json_encodes_paths_so_they_cannot_escape() {
        let script = adopt_script(&[
            "C:\\weird \"quoted\"\\file.txt".to_string(),
            "C:\\line\nbreak.txt".to_string(),
        ]);
        assert!(
            script.starts_with("globalThis.__DSH_HOST_PATHS__"),
            "{script}"
        );
        assert!(script.contains("\\\"quoted\\\""), "{script}");
        assert!(script.contains("\\n"), "{script}");
        assert!(!script.contains("line\nbreak"), "{script}");
        assert_eq!(
            adopt_script(&[]),
            "globalThis.__DSH_HOST_PATHS__ && globalThis.__DSH_HOST_PATHS__.adopt([]);"
        );
    }

    #[test]
    fn host_paths_script_never_fabricates_a_path() {
        // The installed global must answer '' for a file it has not seen.
        assert!(
            HOST_PATHS_SCRIPT.contains("return '';"),
            "{HOST_PATHS_SCRIPT}"
        );
        assert!(
            HOST_PATHS_SCRIPT.contains("if (!file || typeof file.name !== 'string'"),
            "{HOST_PATHS_SCRIPT}"
        );
        // The reference member name and signature are preserved.
        assert!(HOST_PATHS_SCRIPT.contains("pathFor: function (file)"));
    }

    #[test]
    fn absolute_path_check_rejects_relative_and_uri_forms() {
        assert!(is_absolute_host_path("C:\\Users\\me\\x.txt"));
        assert!(is_absolute_host_path("/home/me/x.txt"));
        assert!(!is_absolute_host_path("https://example.com/x"));
        assert!(!is_absolute_host_path(""));
        assert!(!is_absolute_host_path("relative\\x.txt"));
        assert!(!is_absolute_host_path("C:drive-relative"));
    }

    #[test]
    fn the_process_bridge_adopts_consumes_and_clears() {
        clear_drop();
        assert_eq!(adopted_drop(), (Vec::new(), false));
        adopt_drop(["C:\\drop\\a.txt", "https://example.com/"]);
        assert_eq!(adopted_drop(), (vec!["C:\\drop\\a.txt".to_string()], false));
        assert!(consume_drop());
        assert_eq!(adopted_drop(), (Vec::new(), true));
        clear_drop();
        assert_eq!(adopted_drop(), (Vec::new(), false));
    }
}
