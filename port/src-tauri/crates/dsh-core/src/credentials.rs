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
//! - The OS store is **shared process-wide and user-wide**. `DSH_HOME` only
//!   relocates `AppPaths` (index files, logs); it does not relocate OS
//!   credential identities. Two processes that share a user account also share
//!   the `dsh-desktop:*` entries. Owned work (qualification runs, dual-provision
//!   accounts, disposable acceptance machines) therefore needs its own explicit
//!   [`CredentialNamespace`] via [`ScopedKeyringBackend`], which targets a
//!   disjoint set of OS services and can never read or overwrite a default
//!   namespace entry. The default [`KeyringBackend`] path is byte-for-byte
//!   unchanged; nothing in this module reads an environment variable to decide a
//!   namespace, so redirection of the home directory alone can never silently
//!   switch stores.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

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
///
/// The unit value is the **default (production) namespace**: every credential
/// lives under the exact service `dsh-desktop:{provider}` with account
/// `{reference}`. This is the historical layout and it is preserved verbatim;
/// adding namespacing must never move or rename a shipped entry.
pub struct KeyringBackend;

/// `keyring`-backed store scoped to one explicit, owned
/// [`CredentialNamespace`].
///
/// Every credential lives under the service
/// `dsh-desktop:{namespace}:{provider}` with account `{reference}`. Because a
/// `provider` may never contain `:` (see `validate_identity`), a scoped service
/// always has strictly more separators than a default service, so scoped and
/// default targets can never coincide for any provider/reference pair. Two
/// different namespaces can never coincide either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedKeyringBackend {
    namespace: CredentialNamespace,
}

/// Service-name prefix isolating this product's entries in the OS store.
const SERVICE_PREFIX: &str = "dsh-desktop";

/// Maximum accepted namespace length in bytes; the OS service field stays far
/// below every platform's limit (`dsh-desktop` + 64 + 128 + 2 separators).
const MAX_NAMESPACE_LEN: usize = 64;

/// Largest accepted `provider`/`reference` segment, matching `validate_segment`.
const MAX_IDENTITY_LEN: usize = 128;

/// An explicitly opted-in OS-credential namespace.
///
/// Owned work must pass one of these to [`ScopedKeyringBackend::new`]; there is
/// no ambient/default namespace and no environment lookup in this module.
///
/// Accepted forms (both are bounded and contain no separator that could forge a
/// service boundary):
/// - a UUID, which is normalized to canonical lowercase hyphenated form
///   (`Uuid::parse_str`, so `simple`/`braced` inputs collapse to one identity).
///   The nil UUID is rejected: it would make a scoped store look like a
///   "default-ish" one.
/// - otherwise a fixed permitted safe identifier: 1..=`MAX_NAMESPACE_LEN`
///   bytes of `a-z`, `0-9`, `-`, `_`, `.`, starting with `a-z` or `0-9` and not
///   ending in `-` or `.`.
///
/// `SERVICE_PREFIX` itself is reserved and rejected so that a namespace can
/// never spell a default service prefix on its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CredentialNamespace(String);

impl CredentialNamespace {
    /// Generate a fresh, collision-free namespace (preferred for owned runs).
    pub fn new_v4() -> Self {
        Self(uuid::Uuid::new_v4().hyphenated().to_string())
    }

    /// Validate and normalize a caller-supplied namespace.
    pub fn parse(raw: &str) -> Result<Self, DshError> {
        if let Ok(id) = uuid::Uuid::parse_str(raw) {
            if id.is_nil() {
                return Err(reject_namespace("must not be the nil UUID"));
            }
            return Ok(Self(id.hyphenated().to_string()));
        }
        let bytes = raw.as_bytes();
        let starts_ok = matches!(bytes.first(), Some(b'a'..=b'z' | b'0'..=b'9'));
        let ends_ok = matches!(bytes.last(), Some(b'a'..=b'z' | b'0'..=b'9' | b'_'));
        let chars_ok = bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        });
        if bytes.is_empty() {
            return Err(reject_namespace("must not be empty"));
        }
        if bytes.len() > MAX_NAMESPACE_LEN {
            return Err(reject_namespace("must be at most 64 bytes"));
        }
        if !chars_ok {
            return Err(reject_namespace(
                "must be a UUID or use only lowercase ASCII letters, digits, '-', '_', '.'",
            ));
        }
        if !starts_ok {
            return Err(reject_namespace(
                "must start with a lowercase ASCII letter or a digit",
            ));
        }
        if !ends_ok {
            return Err(reject_namespace(
                "must end with a lowercase ASCII letter, a digit, or '_'",
            ));
        }
        if raw == SERVICE_PREFIX {
            return Err(reject_namespace(
                "is reserved; the product service prefix is not a namespace",
            ));
        }
        Ok(Self(raw.to_string()))
    }

    /// The validated namespace segment as used inside an OS service name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn reject_namespace(reason: &str) -> DshError {
    DshError::invalid_argument(
        "credentialNamespace",
        format!(
            "{reason} (a UUID, or 1-64 bytes of [a-z0-9._-] starting and ending alphanumerically)"
        ),
    )
}

impl fmt::Display for CredentialNamespace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<&str> for CredentialNamespace {
    type Error = DshError;

    fn try_from(raw: &str) -> Result<Self, DshError> {
        Self::parse(raw)
    }
}

impl TryFrom<String> for CredentialNamespace {
    type Error = DshError;

    fn try_from(raw: String) -> Result<Self, DshError> {
        Self::parse(&raw)
    }
}

impl FromStr for CredentialNamespace {
    type Err = DshError;

    fn from_str(raw: &str) -> Result<Self, DshError> {
        Self::parse(raw)
    }
}

/// A fully resolved OS-credential target: the `(service, account)` pair handed
/// to `keyring::Entry::new`.
///
/// Resolution is pure (validation + string formatting) and is the single place
/// where a namespace is mapped onto an OS identity, which lets tests prove the
/// exact targets without opening the OS store. [`CredentialTarget::open`] is
/// the only step that touches it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CredentialTarget {
    service: String,
    account: String,
}

impl CredentialTarget {
    fn resolve(
        namespace: Option<&CredentialNamespace>,
        provider: &str,
        reference: &str,
    ) -> Result<Self, DshError> {
        validate_segment("provider", provider)?;
        validate_segment("reference", reference)?;
        Ok(Self {
            service: service_name(namespace, provider),
            account: reference.to_string(),
        })
    }

    fn open(&self) -> Result<keyring::Entry, DshError> {
        keyring::Entry::new(&self.service, &self.account)
            .map_err(|e| DshError::credential_store("access", e.to_string()))
    }
}

/// The OS service name for one provider, in the default namespace
/// (`None`) or in `Some(namespace)`.
fn service_name(namespace: Option<&CredentialNamespace>, provider: &str) -> String {
    match namespace {
        None => format!("{SERVICE_PREFIX}:{provider}"),
        Some(namespace) => format!("{SERVICE_PREFIX}:{namespace}:{provider}"),
    }
}

impl KeyringBackend {
    /// Service-name prefix shared by every default-namespace entry.
    pub const SERVICE_PREFIX: &'static str = SERVICE_PREFIX;

    /// The exact OS service name the default backend uses for `provider`.
    ///
    /// Exposed for diagnostics, acceptance tooling, and cleanup sweeps; the
    /// value is an identity, never secret material.
    pub fn service_target(provider: &str) -> Result<String, DshError> {
        Ok(KeyringBackend.target(provider, "target")?.service)
    }

    fn target(&self, provider: &str, reference: &str) -> Result<CredentialTarget, DshError> {
        CredentialTarget::resolve(None, provider, reference)
    }
}

impl ScopedKeyringBackend {
    /// Build a backend bound to one owned namespace.
    pub fn new(namespace: CredentialNamespace) -> Self {
        Self { namespace }
    }

    /// The namespace this backend is bound to.
    pub fn namespace(&self) -> &CredentialNamespace {
        &self.namespace
    }

    /// The exact OS service name this backend uses for `provider`.
    pub fn service_target(&self, provider: &str) -> Result<String, DshError> {
        Ok(self.target(provider, "target")?.service)
    }

    fn target(&self, provider: &str, reference: &str) -> Result<CredentialTarget, DshError> {
        CredentialTarget::resolve(Some(&self.namespace), provider, reference)
    }
}

impl KeyringBackend {
    /// Convenience constructor mirroring [`ScopedKeyringBackend::new`].
    pub fn scoped(namespace: CredentialNamespace) -> ScopedKeyringBackend {
        ScopedKeyringBackend::new(namespace)
    }
}

macro_rules! impl_secret_backend_for_keyring {
    ($backend:ty) => {
        impl SecretBackend for $backend {
            fn set_secret(
                &self,
                provider: &str,
                reference: &str,
                secret: &str,
            ) -> Result<(), DshError> {
                self.target(provider, reference)?
                    .open()?
                    .set_password(secret)
                    .map_err(|e| DshError::credential_store("store", e.to_string()))
            }

            fn get_secret(
                &self,
                provider: &str,
                reference: &str,
            ) -> Result<Option<String>, DshError> {
                match self.target(provider, reference)?.open()?.get_password() {
                    Ok(secret) => Ok(Some(secret)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(e) => Err(DshError::credential_store("read", e.to_string())),
                }
            }

            fn delete_secret(&self, provider: &str, reference: &str) -> Result<(), DshError> {
                match self
                    .target(provider, reference)?
                    .open()?
                    .delete_credential()
                {
                    Ok(()) => Ok(()),
                    Err(keyring::Error::NoEntry) => {
                        Err(DshError::not_found("credential", reference))
                    }
                    Err(e) => Err(DshError::credential_store("delete", e.to_string())),
                }
            }

            fn has_secret(&self, provider: &str, reference: &str) -> Result<bool, DshError> {
                Ok(self.get_secret(provider, reference)?.is_some())
            }
        }
    };
}

impl_secret_backend_for_keyring!(KeyringBackend);
impl_secret_backend_for_keyring!(ScopedKeyringBackend);

/// Validate a credential identity: non-empty, printable segments that are safe
/// for every OS store's service/account fields.
fn validate_identity(provider: &str, reference: &str) -> Result<(), DshError> {
    validate_segment("provider", provider)?;
    validate_segment("reference", reference)
}

fn validate_segment(field: &str, value: &str) -> Result<(), DshError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_IDENTITY_LEN
        && !value.contains(['\0', '\r', '\n', ':', '\\'])
        && value.bytes().all(|b| b.is_ascii_graphic() || b == b' ');
    if valid {
        return Ok(());
    }
    Err(DshError::invalid_argument(
        field,
        "must be non-empty printable ASCII without ':', '\\', or control characters",
    ))
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
    ///
    /// Uses the default namespace (`dsh-desktop:{provider}`), i.e. exactly the
    /// identities shipped builds have always used.
    pub fn open_os(index_path: &Path) -> Result<Self, DshError> {
        Self::open(index_path, KeyringBackend)
    }
}

impl CredentialStore<ScopedKeyringBackend> {
    /// Open an owned store under an explicit namespace.
    ///
    /// `index_path` should live inside the owned home (the redirected
    /// `AppPaths`) so the metadata index is owned too. Nothing this constructor
    /// opens can read, write, or delete a default-namespace OS identity.
    pub fn open_os_scoped(
        index_path: &Path,
        namespace: CredentialNamespace,
    ) -> Result<Self, DshError> {
        Self::open(index_path, ScopedKeyringBackend::new(namespace))
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

    // ---- namespace targeting (no OS store access) -------------------------
    //
    // These tests exercise only the pure `(service, account)` resolution the
    // keyring backends hand to `keyring::Entry::new`. No credential is created,
    // read, or deleted, so the user's OS secret store is never touched.

    const PROBE_NS: &str = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const OTHER_NS: &str = "11111111-2222-4333-8444-555555555555";

    fn ns(raw: &str) -> CredentialNamespace {
        CredentialNamespace::parse(raw).expect("namespace")
    }

    #[test]
    fn default_backend_targets_the_exact_legacy_service() {
        assert_eq!(KeyringBackend::SERVICE_PREFIX, "dsh-desktop");
        let backend = KeyringBackend;
        let cases = [
            ("client-connection", "dsh-desktop:client-connection"),
            ("gateway", "dsh-desktop:gateway"),
            ("updates", "dsh-desktop:updates"),
        ];
        for (provider, expected) in cases {
            let target = backend.target(provider, "browser-session").expect("target");
            assert_eq!(target.service, expected, "service for {provider}");
            assert_eq!(target.account, "browser-session");
            assert_eq!(
                KeyringBackend::service_target(provider).expect("service_target"),
                expected
            );
        }
    }

    #[test]
    fn scoped_backend_targets_a_namespaced_service() {
        let backend = ScopedKeyringBackend::new(ns(PROBE_NS));
        assert_eq!(backend.namespace().as_str(), PROBE_NS);
        let target = backend
            .target("client-connection", "browser-session")
            .expect("target");
        assert_eq!(
            target.service,
            format!("dsh-desktop:{PROBE_NS}:client-connection")
        );
        assert_eq!(target.account, "browser-session");
        assert_eq!(
            backend
                .service_target("client-connection")
                .expect("service_target"),
            format!("dsh-desktop:{PROBE_NS}:client-connection")
        );
        assert_eq!(KeyringBackend::scoped(ns(PROBE_NS)), backend);
    }

    #[test]
    fn scoped_targets_are_disjoint_from_default_and_each_other() {
        let providers = [
            "client-connection",
            "gateway",
            "updates",
            "a",
            "dsh-desktop",
            "browser-session",
        ];
        let defaults: Vec<String> = providers
            .iter()
            .map(|p| KeyringBackend::service_target(p).expect("default target"))
            .collect();
        let scoped: Vec<String> = [PROBE_NS, OTHER_NS]
            .iter()
            .flat_map(|raw| {
                let backend = ScopedKeyringBackend::new(ns(raw));
                providers
                    .iter()
                    .map(move |p| backend.service_target(p).expect("scoped target"))
            })
            .collect();

        for target in &scoped {
            assert!(
                !defaults.contains(target),
                "scoped target collides with a default service: {target}"
            );
        }
        for (i, left) in scoped.iter().enumerate() {
            for right in &scoped[i + 1..] {
                assert_ne!(left, right, "two scoped targets collide: {left}");
            }
        }
        // Structural guarantee: a provider can never carry ':', so a scoped
        // service has strictly more separators than any default service.
        for provider in providers {
            assert!(
                !service_name(None, provider).contains("::")
                    && service_name(None, provider).matches(':').count() == 1
            );
            assert_eq!(
                service_name(Some(&ns(PROBE_NS)), provider)
                    .matches(':')
                    .count(),
                2,
                "scoped service must carry an extra namespace boundary"
            );
        }
    }

    #[test]
    fn namespace_parsing_normalizes_uuids_and_rejects_unsafe_values() {
        // Uppercase and simple UUID forms collapse onto one identity.
        assert_eq!(
            CredentialNamespace::parse("0F1E2D3C4B5A69788796A5B4C3D2E1F0")
                .expect("uuid")
                .as_str(),
            PROBE_NS
        );
        assert_eq!(
            CredentialNamespace::parse(PROBE_NS).expect("uuid").as_str(),
            PROBE_NS
        );
        assert_eq!(
            CredentialNamespace::new_v4().as_str().len(),
            36,
            "generated namespaces stay bounded"
        );
        let too_long = "a".repeat(MAX_NAMESPACE_LEN + 1);
        for rejected in [
            "",
            "..",
            "-lead",
            "trail-",
            "Upper",
            "with space",
            "with:colon",
            "with/slash",
            "with\\backslash",
            "with\nnewline",
            "00000000-0000-0000-0000-000000000000",
            "dsh-desktop",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    CredentialNamespace::parse(rejected),
                    Err(DshError::InvalidArgument { .. })
                ),
                "namespace {rejected:?} must be rejected"
            );
        }
        for accepted in ["qual", "qual-1", "qual_run.2", "a"] {
            assert!(CredentialNamespace::parse(accepted).is_ok(), "{accepted}");
        }
    }

    #[test]
    fn namespace_validation_never_falls_back_to_the_default_service() {
        // A namespace the validator would have accepted must still be rejected
        // whenever the resulting identity could not stay disjoint; conversely
        // every accepted namespace yields a scoped, not default, service.
        for accepted in ["qual", "qual-1", "qual_run.2"] {
            let namespace = CredentialNamespace::parse(accepted).expect("namespace");
            let service = ScopedKeyringBackend::new(namespace)
                .service_target("client-connection")
                .expect("service");
            assert_ne!(service, "dsh-desktop:client-connection");
            assert!(service.starts_with("dsh-desktop:"));
            assert!(service.contains(':'));
        }
    }

    #[test]
    fn opening_an_os_store_touches_no_credential_until_an_operation_runs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let default_index = dir.path().join("default-index.json");
        let default_store: CredentialStore<KeyringBackend> =
            CredentialStore::open_os(&default_index).expect("open_os");
        assert!(!default_index.exists(), "open must not write the index");
        // An opened default store still resolves to the shipped service names.
        assert_eq!(
            default_store
                .backend
                .target("client-connection", "browser-session")
                .expect("target")
                .service,
            "dsh-desktop:client-connection"
        );

        let scoped_index = dir.path().join("scoped-index.json");
        let scoped_store: CredentialStore<ScopedKeyringBackend> =
            CredentialStore::open_os_scoped(&scoped_index, ns(PROBE_NS)).expect("open_os_scoped");
        assert!(!scoped_index.exists(), "open must not write the index");
        assert_eq!(
            scoped_store.backend.namespace().as_str(),
            PROBE_NS,
            "an owned store is bound to its namespace"
        );
    }
}
