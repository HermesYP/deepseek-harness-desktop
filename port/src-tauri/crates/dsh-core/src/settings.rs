//! Versioned, atomic-write persistent settings store (`settings.json` in the
//! application user-data directory).
//!
//! Contracts:
//! - Every write goes to a temp file in the same directory and is renamed over
//!   the target (write-through on Windows via `MoveFileExW`), so a crash never
//!   leaves a half-written document.
//! - A single-writer advisory lock (`fs4`) serialises read-modify-write cycles
//!   across processes.
//! - The document is versioned (`schemaVersion`); a future schema is refused
//!   loudly and the file is left unchanged.
//! - This store is the authority for **desktop-owned** preferences only.
//!   Harness-owned settings remain under `$DSH_HOME` and are never duplicated
//!   here.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

use crate::error::DshError;
use crate::protocol::SettingValue;

/// Current settings document schema version.
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// On-disk settings document shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocument {
    pub schema_version: u32,
    pub settings: BTreeMap<String, SettingValue>,
}

impl Default for SettingsDocument {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: BTreeMap::new(),
        }
    }
}

/// Atomic single-writer settings store.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    document: SettingsDocument,
}

/// Validate a settings key: lower-case dotted segments, so keys can never
/// collide with Harness-owned naming or smuggle path separators.
pub fn validate_key(key: &str) -> Result<(), DshError> {
    let valid = !key.is_empty()
        && key.len() <= 256
        && !key.starts_with('.')
        && !key.ends_with('.')
        && key.split('.').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 64
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(DshError::invalid_argument(
            "key",
            "settings keys are lower-case dotted segments (a-z, 0-9, '-') of at most 256 characters",
        ))
    }
}

/// Atomic replacement: write a sibling temp file, then rename over the target.
/// Windows uses `MoveFileExW` with `MOVEFILE_WRITE_THROUGH` (the upstream
/// publication semantics); other platforms use `rename(2)` within the directory.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), DshError> {
    let directory = path.parent().ok_or_else(|| {
        DshError::io("write", Some(path.display().to_string()), &"path has no parent directory")
    })?;
    std::fs::create_dir_all(directory)
        .map_err(|e| DshError::io("create directory", Some(directory.display().to_string()), &e))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("settings.json");
    let temp = directory.join(format!(".{file_name}.tmp-{}", std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        set_owner_only(&mut options);
        let mut file = options
            .open(&temp)
            .map_err(|e| DshError::io("create temp file", Some(temp.display().to_string()), &e))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| DshError::io("write temp file", Some(temp.display().to_string()), &e))?;
        file.sync_all()
            .map_err(|e| DshError::io("flush temp file", Some(temp.display().to_string()), &e))?;
    }
    replace_file(&temp, path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_owner_only(_options: &mut std::fs::OpenOptions) {}

/// Rename `from` onto `to` atomically.
#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), DshError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let wide = |p: &Path| -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    };
    let (from_wide, to_wide) = (wide(from), wide(to));
    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(DshError::io(
            "rename into place",
            Some(to.display().to_string()),
            &std::io::Error::last_os_error(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), DshError> {
    std::fs::rename(from, to)
        .map_err(|e| DshError::io("rename into place", Some(to.display().to_string()), &e))
}

impl SettingsStore {
    /// Open (and load) the store at `path`, creating an empty document when absent.
    /// A future `schemaVersion` or a malformed document is refused without touching the file.
    pub fn open(path: &Path) -> Result<Self, DshError> {
        let document = read_document(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            document,
        })
    }

    /// Read one setting; `None` when the key is unset.
    pub fn get(&self, key: &str) -> Result<Option<&SettingValue>, DshError> {
        validate_key(key)?;
        Ok(self.document.settings.get(key))
    }

    /// All settings (metadata-safe: values are plain JSON scalars).
    pub fn list(&self) -> &BTreeMap<String, SettingValue> {
        &self.document.settings
    }

    /// Write one setting with an atomic replace (read-modify-write under the lock).
    pub fn set(&mut self, key: &str, value: SettingValue) -> Result<(), DshError> {
        validate_key(key)?;
        self.mutate(|document| {
            document.settings.insert(key.to_string(), value);
        })
    }

    /// Remove one setting (missing keys are a `NotFound` error, never silent).
    pub fn reset(&mut self, key: &str) -> Result<(), DshError> {
        validate_key(key)?;
        if !self.document.settings.contains_key(key) {
            return Err(DshError::not_found("setting", key));
        }
        self.mutate(|document| {
            document.settings.remove(key);
        })
    }

    /// Path of the backing file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn mutate(&mut self, update: impl FnOnce(&mut SettingsDocument)) -> Result<(), DshError> {
        let mut document = self.reload_and_lock()?;
        update(&mut document);
        let raw = serde_json::to_string(&document)
            .map_err(|e| DshError::io("serialize", Some(self.path.display().to_string()), &e))?;
        write_atomic(&self.path, &raw)?;
        self.document = document;
        Ok(())
    }

    /// Re-read under the exclusive lock so an external writer's changes are never lost.
    fn reload_and_lock(&self) -> Result<SettingsDocument, DshError> {
        let lock_path = self.path.with_extension("lock");
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| DshError::io("open lock", Some(lock_path.display().to_string()), &e))?;
        lock.try_lock_exclusive().map_err(|e| {
            DshError::io("lock settings", Some(self.path.display().to_string()), &e)
        })?;
        let document = read_document(&self.path)?;
        // The lock is released when `lock` drops at the end of the transaction.
        drop(lock);
        Ok(document)
    }
}

fn read_document(path: &Path) -> Result<SettingsDocument, DshError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SettingsDocument::default()),
        Err(e) => return Err(DshError::io("read", Some(path.display().to_string()), &e)),
    };
    parse_document(&raw, path)
}

/// Parse and version-check a settings document. Unknown future schemas fail
/// loudly and leave the file untouched.
pub fn parse_document(raw: &str, path: &Path) -> Result<SettingsDocument, DshError> {
    let document: SettingsDocument = serde_json::from_str(raw)
        .map_err(|e| DshError::io("parse", Some(path.display().to_string()), &e))?;
    if document.schema_version > SETTINGS_SCHEMA_VERSION {
        return Err(DshError::other(
            "settings_schema_future",
            format!(
                "settings document schemaVersion {} is newer than supported {}; leaving it unchanged",
                document.schema_version, SETTINGS_SCHEMA_VERSION
            ),
        ));
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(dir: &Path) -> SettingsStore {
        SettingsStore::open(&dir.join("settings.json")).expect("open store")
    }

    #[test]
    fn set_get_reset_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = temp_store(dir.path());
        store.set("locale.preference", SettingValue::String("zh".into())).expect("set");
        assert_eq!(
            store.get("locale.preference").expect("get").cloned(),
            Some(SettingValue::String("zh".into()))
        );
        store.reset("locale.preference").expect("reset");
        assert_eq!(store.get("locale.preference").expect("get"), None);
        assert!(matches!(
            store.reset("locale.preference"),
            Err(DshError::NotFound { .. })
        ));
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temp_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = temp_store(dir.path());
        for index in 0..25 {
            store
                .set(&format!("key{index}"), SettingValue::Number(serde_json::Number::from(index)))
                .expect("set");
        }
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must be renamed away: {leftovers:?}");
        // Every committed write is readable in full.
        let reopened = SettingsStore::open(dir.path().join("settings.json").as_path()).expect("reopen");
        assert_eq!(reopened.list().len(), 25);
    }

    #[test]
    fn future_schema_is_refused_and_file_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        let raw = r#"{"schemaVersion":2,"settings":{"a":"b"}}"#;
        std::fs::write(&path, raw).expect("seed");
        let error = SettingsStore::open(&path).expect_err("future schema must fail");
        assert!(matches!(error, DshError::Other { code, .. } if code == "settings_schema_future"));
        assert_eq!(std::fs::read_to_string(&path).expect("reread"), raw, "file must stay unchanged");
    }

    #[test]
    fn malformed_document_is_refused_loudly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{not json").expect("seed");
        assert!(matches!(SettingsStore::open(&path), Err(DshError::Io { .. })));
    }

    #[test]
    fn keys_are_validated() {
        for bad in ["", ".a", "a.", "A", "a b", "a/b", "a..b", &"x".repeat(300)] {
            assert!(validate_key(bad).is_err(), "key {bad:?} must be rejected");
        }
        for good in ["a", "locale.preference", "updates.feed-url", "x.y.z9"] {
            assert!(validate_key(good).is_ok(), "key {good:?} must be accepted");
        }
    }

    #[test]
    fn missing_file_reads_as_empty_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = temp_store(dir.path());
        assert_eq!(*store.list(), BTreeMap::new());
        assert!(!dir.path().join("settings.json").exists(), "open must not create eagerly");
    }
}
