//! OS-backed credential storage (Windows Credential Manager / macOS Keychain /
//! Linux Secret Service) through the `keyring` crate.
//!
//! Contracts:
//! - Secret values exist only in the OS store. They are never logged, never
//!   traced, never written to disk by Rust, and never returned by `list`.
//! - `list` returns metadata (`provider`, `reference`, `hasSecret`, `updatedAt`)
//!   from the on-disk **metadata index**, which deliberately contains no secret
//!   material.
//! - The gateway's browser-session signing secret lives here
//!   (`provider = "client-connection"`, `reference = "browser-session"`), not on
//!   disk in the frontend and not in any log.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::DshError;
use crate::protocol::CredentialRef;
use crate::settings::write_atomic;

/// Secret-storage backend. Production uses [`KeyringBackend`]; tests use an
/// in-memory implementation to keep the OS store untouched.
pub trait SecretBackend: Send + Sync {
    /// Write one secret, replacing any existing value.
    fn set_secret(&self, provider: &str, reference: &str, secret: &str) -> Result<(), DshError>;
    /// Read one secret; `None` when absent.
    fn get_secret(&self, provider: &str, reference: &str) -> Result<Option<String>, DshError>;
    /// Delete one secret; an absent entry is an error (loud, never silent).
    fn delete_secret(&self, provider: &str, reference: &str) -> Result<(), DshError>;
    /// Presence check without returning the value.
    fn has_secret(&self, provider: &str, reference: &str) -> Result<bool, DshError>;
}

/// `keyring`-backed store: Windows Credential Manager, macOS Keychain,
/// Linux Secret Service.
pub struct KeyringBackend;

/// Service-name prefix isolating this product's entries in the OS store.
const SERVICE_PREFIX: &str = "dsh-desktop";

fn entry(provider: &str, reference: &str) -> Result<keyring::Entry, DshError> {
    validate_identity(provider, reference)?;
    keyring::Entry::new(&format!("{SERVICE_PREFIX}:{provider}"), reference)
        .map_err(|e| DshError::credential_store("access", e.to_string()))
}

impl SecretBackend for KeyringBackend {
    fn set_secret(&self, provider: &str, reference: &str, secret: &str) -> Result<(), DshError> {
        entry(provider, reference)?
            .set_password(secret)
            .map_err(|e| DshError::credential_store("store", e.to_string()))
    }

    fn get_secret(&self, provider: &str, reference: &str) -> Result<Option<String>, DshError> {
        match entry(provider, reference)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(DshError::credential_store("read", e.to_string())),
        }
    }

    fn delete_secret(&self, provider: &str, reference: &str) -> Result<(), DshError> {
        match entry(provider, reference)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Err(DshError::not_found("credential", reference)),
            Err(e) => Err(DshError::credential_store("delete", e.to_string())),
        }
    }

    fn has_secret(&self, provider: &str, reference: &str) -> Result<bool, DshError> {
        Ok(self.get_secret(provider, reference)?.is_some())
    }
}

/// Validate a credential identity: non-empty, printable segments that are safe
/// for every OS store's service/account fields.
fn validate_identity(provider: &str, reference: &str) -> Result<(), DshError> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && !value.contains(['\0', '\r', '\n', ':', '\\'])
            && value.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
    };
    if !valid(provider) {
        return Err(DshError::invalid_argument(
            "provider",
            "must be non-empty printable ASCII without ':', '\\', or control characters",
        ));
    }
    if !valid(reference) {
        return Err(DshError::invalid_argument(
            "reference",
            "must be non-empty printable ASCII without ':', '\\', or control characters",
        ));
    }
    Ok(())
}

/// On-disk metadata index (NO secrets).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialIndex {
    schema_version: u32,
    entries: BTreeMap<String, CredentialRef>,
}

/// Credential store: OS-backed secrets plus a metadata-only index.
pub struct CredentialStore<B: SecretBackend = KeyringBackend> {
    backend: B,
    index_path: PathBuf,
    index: CredentialIndex,
}

fn index_key(provider: &str, reference: &str) -> String {
    format!("{provider}\u{0}{reference}")
}

impl CredentialStore<KeyringBackend> {
    /// Open the production store; `index_path` holds metadata only.
    pub fn open_os(index_path: &Path) -> Result<Self, DshError> {
        Self::open(index_path, KeyringBackend)
    }
}

impl<B: SecretBackend> CredentialStore<B> {
    /// Open a store over any backend (used by tests and the OS implementation).
    pub fn open(index_path: &Path, backend: B) -> Result<Self, DshError> {
        let index = match std::fs::read_to_string(index_path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|e| DshError::io("parse", Some(index_path.display().to_string()), &e))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => CredentialIndex {
                schema_version: 1,
                entries: BTreeMap::new(),
            },
            Err(e) => {
                return Err(DshError::io(
                    "read",
                    Some(index_path.display().to_string()),
                    &e,
                ))
            }
        };
        Ok(Self {
            backend,
            index_path: index_path.to_path_buf(),
            index,
        })
    }

    /// Store one secret. The value travels in memory only and is written to the OS store.
    pub fn store(&mut self, provider: &str, reference: &str, secret: &str) -> Result<(), DshError> {
        validate_identity(provider, reference)?;
        self.backend.set_secret(provider, reference, secret)?;
        self.index.entries.insert(
            index_key(provider, reference),
            CredentialRef {
                provider: provider.to_string(),
                reference: reference.to_string(),
                has_secret: true,
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        self.save_index()
    }

    /// Read one secret from the OS store. Callers must not log or echo it.
    pub fn get(&self, provider: &str, reference: &str) -> Result<Option<String>, DshError> {
        validate_identity(provider, reference)?;
        self.backend.get_secret(provider, reference)
    }

    /// Presence check (metadata API; safe to surface).
    pub fn has(&self, provider: &str, reference: &str) -> Result<bool, DshError> {
        validate_identity(provider, reference)?;
        self.backend.has_secret(provider, reference)
    }

    /// Delete one secret and its metadata row.
    pub fn delete(&mut self, provider: &str, reference: &str) -> Result<(), DshError> {
        validate_identity(provider, reference)?;
        self.backend.delete_secret(provider, reference)?;
        self.index.entries.remove(&index_key(provider, reference));
        self.save_index()
    }

    /// Metadata only: never returns secret values. `hasSecret` is re-checked
    /// against the OS store so stale rows report honestly.
    pub fn list(&mut self) -> Result<Vec<CredentialRef>, DshError> {
        let mut rows = Vec::new();
        let keys: Vec<String> = self.index.entries.keys().cloned().collect();
        for key in keys {
            let Some(row) = self.index.entries.get(&key).cloned() else {
                continue;
            };
            let present = self.backend.has_secret(&row.provider, &row.reference)?;
            if present != row.has_secret {
                self.index.entries.insert(
                    key,
                    CredentialRef {
                        has_secret: present,
                        ..row.clone()
                    },
                );
            }
            rows.push(CredentialRef {
                has_secret: present,
                ..row
            });
        }
        Ok(rows)
    }

    fn save_index(&self) -> Result<(), DshError> {
        let raw = serde_json::to_string(&self.index).map_err(|e| {
            DshError::io("serialize", Some(self.index_path.display().to_string()), &e)
        })?;
        write_atomic(&self.index_path, &raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// In-memory backend: exercises the store's own contracts without touching
    /// the user's OS credential store.
    #[derive(Default)]
    struct MemoryBackend {
        secrets: Mutex<BTreeMap<(String, String), String>>,
    }

    impl SecretBackend for MemoryBackend {
        fn set_secret(
            &self,
            provider: &str,
            reference: &str,
            secret: &str,
        ) -> Result<(), DshError> {
            self.secrets.lock().expect("lock").insert(
                (provider.to_string(), reference.to_string()),
                secret.to_string(),
            );
            Ok(())
        }

        fn get_secret(&self, provider: &str, reference: &str) -> Result<Option<String>, DshError> {
            Ok(self
                .secrets
                .lock()
                .expect("lock")
                .get(&(provider.to_string(), reference.to_string()))
                .cloned())
        }

        fn delete_secret(&self, provider: &str, reference: &str) -> Result<(), DshError> {
            let removed = self
                .secrets
                .lock()
                .expect("lock")
                .remove(&(provider.to_string(), reference.to_string()));
            match removed {
                Some(_) => Ok(()),
                None => Err(DshError::not_found("credential", reference)),
            }
        }

        fn has_secret(&self, provider: &str, reference: &str) -> Result<bool, DshError> {
            Ok(self
                .secrets
                .lock()
                .expect("lock")
                .contains_key(&(provider.to_string(), reference.to_string())))
        }
    }

    fn temp_store(dir: &Path) -> CredentialStore<MemoryBackend> {
        CredentialStore::open(
            &dir.join("credentials-index.json"),
            MemoryBackend::default(),
        )
        .expect("open store")
    }

    #[test]
    fn round_trip_store_get_has_delete() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = temp_store(dir.path());
        store
            .store("client-connection", "browser-session", "s3cret ✓")
            .expect("store");
        assert_eq!(
            store
                .get("client-connection", "browser-session")
                .expect("get")
                .as_deref(),
            Some("s3cret ✓")
        );
        assert!(store
            .has("client-connection", "browser-session")
            .expect("has"));
        store
            .delete("client-connection", "browser-session")
            .expect("delete");
        assert!(!store
            .has("client-connection", "browser-session")
            .expect("has"));
        assert!(matches!(
            store.delete("client-connection", "browser-session"),
            Err(DshError::NotFound { .. })
        ));
    }

    #[test]
    fn list_never_returns_secrets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = temp_store(dir.path());
        let secret = "super-secret-value";
        store.store("p1", "r1", secret).expect("store");
        store.store("p2", "r2", "other-secret").expect("store");
        let rows = store.list().expect("list");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.has_secret));
        let rendered = serde_json::to_string(&rows).expect("serialize");
        assert!(!rendered.contains(secret), "list output leaked a secret");
        assert!(
            !rendered.contains("other-secret"),
            "list output leaked a secret"
        );
        // The metadata index on disk contains no secret material either.
        let index_raw =
            std::fs::read_to_string(dir.path().join("credentials-index.json")).expect("read index");
        assert!(!index_raw.contains(secret));
        assert!(!index_raw.contains("other-secret"));
    }

    #[test]
    fn list_reports_external_deletions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = temp_store(dir.path());
        store.store("p", "r", "v").expect("store");
        // Externally remove the OS entry; the row must report hasSecret=false.
        store
            .backend
            .delete_secret("p", "r")
            .expect("external delete");
        let rows = store.list().expect("list");
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].has_secret);
    }

    #[test]
    fn invalid_identities_are_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = temp_store(dir.path());
        for (provider, reference) in [
            ("", "r"),
            ("p", ""),
            ("p:q", "r"),
            ("p", "a\\b"),
            ("p", "a\nb"),
        ] {
            assert!(matches!(
                store.store(provider, reference, "v"),
                Err(DshError::InvalidArgument { .. })
            ));
        }
    }
}
